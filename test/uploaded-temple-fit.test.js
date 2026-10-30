import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {prepareGlasses} from '../public/prepare-glasses.js';
import {isTempleRegion,createEarOccluders,updateEarOccluders} from '../public/tryon-ears.js';
import {updateTempleVisibility} from '../public/tryon-temple-visibility.js';

const bytes=await fs.readFile(new URL('../public/products/models-v2/head-blue.glb',import.meta.url));
const productionSource='a9f40b82bcc1314c2024bcfb570b2675ff55d3e7052e0c006ba77054f6f90325';
async function fixture(mode){
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),'');
 delete gltf.asset.extras;
 if(['fused','multiple','nonindexed'].includes(mode)){
  const meshes=[];gltf.scene.updateMatrixWorld(true);gltf.scene.traverse(m=>{if(m.isMesh)meshes.push(m);});
  const geometry=mergeGeometries(meshes.map(m=>{const g=m.geometry.clone().applyMatrix4(m.matrixWorld);g.deleteAttribute('color');return g;}),true);
  const frame=meshes.find(m=>m.material.name==='frame').material,lens=meshes.find(m=>m.material.name==='Blue_Lenses').material;
  let material=frame;
  if(mode==='multiple'){
   const extra=frame.clone();extra.name='hinge';material=[frame,extra,lens];
   geometry.groups.forEach((group,i)=>{group.materialIndex=meshes[i].material===lens?2:0;});
   const group=geometry.groups.find(g=>g.materialIndex===0),half=Math.floor(group.count/6)*3;
   geometry.addGroup(group.start+half,group.count-half,1);group.count=half;
  }else geometry.clearGroups();
  gltf.scene.clear();gltf.scene.add(new THREE.Mesh(mode==='nonindexed'?geometry.toNonIndexed():geometry,material));
 }
 if(mode==='rotated')gltf.scene.rotation.z=-Math.PI/2;
 if(mode==='short')gltf.scene.traverse(m=>{if(m.isMesh)m.geometry.scale(1,1,.7);});
 return gltf;
}
function assignment(mesh){
 const g=mesh.geometry,index=g.index,count=index?.count??g.attributes.position.count;
 const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
 const groups=Array.isArray(mesh.material)&&g.groups.length?g.groups:[{start:0,count,materialIndex:0}];
 const result=new Map();
 for(const group of groups){
  const material=materials[group.materialIndex];if(!result.has(material))result.set(material,[]);
  for(let j=group.start;j<group.start+group.count;j+=3)result.get(material).push([0,1,2].map(k=>index?index.getX(j+k):j+k).join(','));
 }
 for(const list of result.values())list.sort();return result;
}
for(const mode of ['separate','fused','multiple','nonindexed','rotated','short'])test(`admin upload: ${mode} gets real temple fitting and ear clipping without a reviewed fingerprint`,async()=>{
 const gltf=await fixture(mode),records=[];
 gltf.scene.traverse(mesh=>{if(mesh.isMesh)records.push({mesh,positions:mesh.geometry.attributes.position.clone(),uv:mesh.geometry.attributes.uv?.array.slice(),assignment:assignment(mesh)});});
 const product={name:'12028',sourceSha256:productionSource,modelRotation:mode==='rotated'?[0,0,90]:[0,0,0]};
 const model=prepareGlasses(gltf,product),fitting=model.userData.fitting,control=model.userData.templeVisibility;
 assert.equal(fitting.templeFit?.method,'geometry');assert.ok(fitting.templeFit.movedVertices>1000);
 assert.equal(fitting.templeFit.adjustment,'hinge-rotation');
 assert.equal(fitting.templeFit.lengthScale,1,'changing hinge angle must never stretch the authored arm');assert.equal(fitting.templeFitSkipped,null);
 assert.deepEqual([...new Set(control.arms.map(a=>a.side))].sort(),[-1,1]);
 assert.equal(gltf.asset.extras,undefined,'unknown uploads must never acquire a forged reviewed profile');
 model.updateMatrixWorld(true);let unchanged=0,moved=0;const rigidSamples=[[],[]];
 // Compare source vertices in the oriented pre-normalization coordinates.
 const oriented=gltf.scene.parent;oriented.updateMatrixWorld(true);
 for(const {mesh,positions,uv,assignment:before} of records){
  assert.deepEqual(assignment(mesh),before,'each triangle keeps its exact material');
  if(uv)assert.deepEqual(mesh.geometry.attributes.uv.array,uv,'texture coordinates remain exact');
  const transform=mesh.matrixWorld.clone().premultiply(oriented.parent.matrixWorld.clone().invert());
  for(let i=0;i<positions.count;i++){
   const point=new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(transform).sub(new THREE.Vector3(...fitting.anchor)).multiplyScalar(14/fitting.referenceWidth);
   const same=[positions.getX(i),positions.getY(i),positions.getZ(i)].every((v,k)=>v===mesh.geometry.attributes.position.array[i*3+k]);
   if(!isTempleRegion(point.x,point.z+5.5)){assert.ok(same,'front rim and bridge must not move');unchanged++;}
   if(!same){
    moved++;
    const side=point.x<0?0:1,hinge=fitting.templeFit.hinges[side],pivot=new THREE.Vector3(...hinge.pivot);
    const after=new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(transform).sub(new THREE.Vector3(...fitting.anchor)).multiplyScalar(14/fitting.referenceWidth);
    point.y+=2.625;point.z+=5.5;after.y+=2.625;after.z+=5.5;
    const expected=point.clone().sub(pivot).applyQuaternion(new THREE.Quaternion(...hinge.quaternion)).add(pivot);
    assert.ok(after.distanceTo(expected)<2e-6,'every arm vertex follows ONE hinge rotation, including the original hook');
    if(i%97===0)rigidSamples[side].push({before:point.clone(),after});
   }
  }
 }
 assert.ok(unchanged>1000&&moved>1000);
 for(const samples of rigidSamples)for(let i=1;i<samples.length;i++){
  const a=samples[i-1],b=samples[i];assert.ok(Math.abs(a.before.distanceTo(b.before)-a.after.distanceTo(b.after))<3e-6,'shaft thickness, hook curvature and distances are preserved');
 }
 for(const [pitch,yaw,roll] of [[0,0,0],[.5,1,.4],[.5,-1,-.4],[1,0,0]]){
  const fit={translation:new THREE.Vector3(0,-1,-35),quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,roll)),metricScale:1};
  model.position.set(0,2.625,5.5).applyQuaternion(fit.quaternion).add(fit.translation);model.quaternion.copy(fit.quaternion);model.scale.setScalar(14);
  const ears=createEarOccluders();updateEarOccluders(ears,fit);updateTempleVisibility(model,[ears]);
  if(mode!=='short')for(const side of [-1,1])assert.ok(control.arms.some(a=>a.side===side&&a.group.count<a.ends.length*3),'each side loses its rear suffix');
  for(const arm of control.arms){if(mode!=='short')assert.ok(Number.isFinite(arm.earCutoff),'both shafts enter their ear support');assert.ok(arm.ends.slice(0,arm.group.count/3).every(d=>d<=arm.cutoff));}
 }
 updateTempleVisibility(model,[]);
 for(const arm of control.arms)assert.equal(arm.group.count,arm.ends.length*3,'preview restores the complete authored shaft');
});

test('flat uploads are left intact with an explicit reason instead of bending their rims',()=>{
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(14,5,8,8),new THREE.MeshStandardMaterial());
 const positions=mesh.geometry.attributes.position.array.slice(),gltf={asset:{version:'2.0'},scene:new THREE.Group().add(mesh)};
 const model=prepareGlasses(gltf,{sourceSha256:productionSource});
 assert.equal(model.userData.fitting.templeFit,null);assert.equal(model.userData.fitting.templeFitSkipped,'rear-arms-not-found');
 assert.equal(model.userData.templeVisibility,undefined);assert.deepEqual(mesh.geometry.attributes.position.array,positions);
});

test('animated uploads are not destructively bent',async()=>{
 const gltf=await fixture('separate');let geometry;
 gltf.scene.traverse(mesh=>{if(mesh.isMesh&&!geometry){geometry=mesh.geometry;geometry.morphAttributes.position=[geometry.attributes.position.clone()];}});
 const positions=geometry.attributes.position.array.slice(),model=prepareGlasses(gltf);
 assert.equal(model.userData.fitting.templeFitSkipped,'animated-geometry');assert.equal(model.userData.fitting.templeFit,null);
 assert.deepEqual(geometry.attributes.position.array,positions);
});
