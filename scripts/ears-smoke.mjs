import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3198',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3198');
  const report=await page.evaluate(async(modelUrl)=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {prepareKnownTempleFit,createEarOccluders,updateEarOccluders,TEMPLE_SUPPORT,EAR_TEMPLATE}=await import('/tryon-ears.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js');
    const {CAMERA_FOV,projectCameraPoint}=await import('/tryon-perspective.js');
    const gltf=await new GLTFLoader().loadAsync(modelUrl);
    prepareKnownMaterials(gltf);
    const records=[];gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(mesh=>{if(!mesh.isMesh)return;
      const indices=mesh.geometry.index.array.slice(),lensVertices=new Set();
      for(const group of mesh.geometry.groups)if(group.materialIndex===1)for(let j=group.start;j<group.start+group.count;j++)lensVertices.add(indices[j]);
      records.push({mesh,positions:mesh.geometry.attributes.position.array.slice(),uv:mesh.geometry.attributes.uv?.array.slice(),
        normals:mesh.geometry.attributes.normal.array.slice(),tangents:mesh.geometry.attributes.tangent?.array.slice(),indices,material:mesh.material,lensVertices});
    });
    const adjustment=prepareKnownTempleFit(gltf);
    const profile=gltf.asset.extras.lunetteCaba,anchor=new THREE.Vector3(...profile.anchor),scale=14/profile.referenceWidth;
    let unchangedFront=true,unchangedFrontShading=true,maxLift=0,minLift=Infinity,maxSplay=0,minSplay=Infinity,maxExtension=0,minExtension=Infinity;
    const supportHeights=[],contactVertices=[0,0],closestContact=[{distance:Infinity},{distance:Infinity}];let rigidError=0,preserved=true;
    for(const {mesh,positions,uv,normals,tangents,indices,material,lensVertices} of records){
      const after=mesh.geometry.attributes.position;
      for(let i=0;i<after.count;i++){
        const before=new THREE.Vector3().fromArray(positions,i*3).applyMatrix4(mesh.matrixWorld).sub(anchor).multiplyScalar(scale).add(new THREE.Vector3(0,2.625,5.5));
        const point=new THREE.Vector3().fromBufferAttribute(after,i).applyMatrix4(mesh.matrixWorld).sub(anchor).multiplyScalar(scale).add(new THREE.Vector3(0,2.625,5.5));
        if(lensVertices.has(i)||before.z>=4||(Math.abs(before.x)<=5.3&&(Math.abs(before.x)<=TEMPLE_SUPPORT.innerX||before.z>=-2))){
          unchangedFront&&=positions[i*3]===after.getX(i)&&positions[i*3+1]===after.getY(i)&&positions[i*3+2]===after.getZ(i);
          for(let j=0;j<3;j++)unchangedFrontShading&&=normals[i*3+j]===mesh.geometry.attributes.normal.array[i*3+j];
          if(tangents)for(let j=0;j<4;j++)unchangedFrontShading&&=tangents[i*4+j]===mesh.geometry.attributes.tangent.array[i*4+j];
        }
        maxLift=Math.max(maxLift,point.y-before.y);minLift=Math.min(minLift,point.y-before.y);
        const splay=Math.sign(before.x)*(point.x-before.x);
        maxSplay=Math.max(maxSplay,splay);minSplay=Math.min(minSplay,splay);
        maxExtension=Math.max(maxExtension,before.z-point.z);minExtension=Math.min(minExtension,before.z-point.z);
        if(!lensVertices.has(i)&&before.z<4&&(Math.abs(before.x)>5.3||(Math.abs(before.x)>TEMPLE_SUPPORT.innerX&&before.z< -2))){
          const hinge=adjustment.hinges[before.x<0?0:1],pivot=new THREE.Vector3(...hinge.pivot);
          const expected=before.clone().sub(pivot).applyQuaternion(new THREE.Quaternion(...hinge.quaternion)).add(pivot);
          rigidError=Math.max(rigidError,expected.distanceTo(point));
        }
        if(Math.abs(point.x)>5.5&&point.z>TEMPLE_SUPPORT.contactZ+.3&&point.z<TEMPLE_SUPPORT.contactZ+.6)supportHeights.push(point.y);
        if(Math.abs(point.z-TEMPLE_SUPPORT.contactZ)<.2){
          const distance=((Math.abs(point.x)-EAR_TEMPLATE.x)/EAR_TEMPLATE.radiusX)**2+((point.y-EAR_TEMPLATE.y)/EAR_TEMPLATE.radiusY)**2+((point.z-EAR_TEMPLATE.z)/EAR_TEMPLATE.radiusZ)**2;
          const side=point.x<0?0:1;if(distance<closestContact[side].distance)closestContact[side]={distance,point:point.toArray()};if(distance<1)contactVertices[side]++;
        }
      }
      preserved&&=indices.every((n,i)=>n===mesh.geometry.index.array[i])&&(!uv||uv.every((n,i)=>n===mesh.geometry.attributes.uv.array[i]))&&material===mesh.material;
    }
    const repeat=prepareKnownTempleFit(gltf),unknown=prepareKnownTempleFit({asset:{extras:{}},scene:gltf.scene});
    const scene=new THREE.Scene(),ears=createEarOccluders();scene.add(ears);
    const probe=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4),new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));scene.add(probe);
    const camera=new THREE.PerspectiveCamera(CAMERA_FOV,1,.1,500),renderer=new THREE.WebGLRenderer({alpha:true,antialias:false});
    renderer.setSize(480,480);const target=new THREE.WebGLRenderTarget(480,480);renderer.setRenderTarget(target);
    const probes=[];
    for(const side of [-1,1])for(const roll of [0,.3]){
      const fit={translation:new THREE.Vector3(0,0,-40),quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,-side*1,side*roll)),metricScale:1};
      updateEarOccluders(ears,fit);
      for(const [name,local,hidden] of [
        ['hook behind ear',[side*7.2,2.8,-7.3],true],
        ['shaft above ear',[side*6.9,4.85,-7.3],false],
        ['temple ahead of ear',[side*6.7,4.2,-2.7],false]
      ]){
        probe.position.set(...local).applyQuaternion(fit.quaternion).add(fit.translation);
        const screen=projectCameraPoint(probe.position),pixel=new Uint8Array(4);
        const visible=masked=>{ears.visible=masked;renderer.render(scene,camera);renderer.readRenderTargetPixels(target,Math.floor(screen.x*480),Math.floor((1-screen.y)*480),1,1,pixel);return pixel[3]>200;};
        probes.push({name,side,roll,hidden,unmasked:visible(false),masked:visible(true)});
      }
    }
    renderer.dispose();target.dispose();
    return {adjustment,unchangedFront,unchangedFrontShading,maxLift,minLift,maxSplay,minSplay,maxExtension,minExtension,preserved,repeat,unknown,
      minimumSupportHeight:Math.min(...supportHeights),supportVertices:supportHeights.length,contactVertices,closestContact,rigidError,probes};
  },process.env.TRYON_MODEL_URL||'/products/head-12028/head-12028-generated.glb');
  assert.ok(report.adjustment?.movedVertices>1000);assert.ok(report.unchangedFront&&report.unchangedFrontShading&&report.preserved);
  assert.equal(report.adjustment.lengthScale,1);assert.equal(report.adjustment.adjustment,'hinge-rotation');
  assert.ok(report.rigidError<.00001,'all rear vertices follow one rigid rotation per hinge; no local bending or stretching');
  assert.ok(report.adjustment.hinges.every(h=>h.angleDegrees>=0&&h.angleDegrees<=25));
  assert.ok(Math.abs(report.maxLift-report.adjustment.maxLiftCm)<.001);
  assert.ok(Math.abs(report.maxExtension-report.adjustment.maxExtensionCm)<.001);
  assert.ok(Math.abs(report.maxSplay-report.adjustment.maxSplayCm)<.001);
  assert.equal(report.repeat,null);assert.equal(report.unknown,null);
  for(const probe of report.probes){
    assert.ok(probe.unmasked,`${probe.name}: reference probe must be visible`);
    assert.equal(probe.masked,!probe.hidden,`${probe.name}, side ${probe.side}, roll ${probe.roll}: wrong ear occlusion`);
  }
  console.log('PASS: rear temples rotate rigidly at their hinges; front/lenses, UVs and materials stay intact; ear masks hide rear hooks and preserve shafts above/in front of ears on both sides.');
  console.log({movedVertices:report.adjustment.movedVertices,maxLiftCm:report.maxLift,maxSplayCm:report.maxSplay,contactVertices:report.contactVertices,probes:report.probes.length});
} finally {await browser?.close();child.kill();}
