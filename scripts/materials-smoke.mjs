import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3196',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3196');
  const report=await page.evaluate(async(modelUrl)=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js');
    const gltf=await new GLTFLoader().loadAsync(modelUrl);
    let mesh;gltf.scene.traverse(o=>{if(o.isMesh)mesh=o;});
    const originalCount=mesh.geometry.index.count,positions=mesh.geometry.attributes.position.array.slice();
    const sourceColour=mesh.material.map,sourceNormals=mesh.geometry.attributes.normal.array.slice();let sourceDisposed=false;
    sourceColour.addEventListener('dispose',()=>{sourceDisposed=true;});
    const profile=prepareKnownMaterials(gltf);
    const unchanged=positions.every((v,i)=>v===mesh.geometry.attributes.position.array[i]);
    gltf.scene.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(),hits=[];
    for(const side of [-1,1])for(const x of [.15,.22,.29])for(const y of [.1,.14,.18]){
      ray.set(new THREE.Vector3(side*x,y,3),new THREE.Vector3(0,0,-1));
      hits.push(ray.intersectObject(gltf.scene,true)[0]?.face.materialIndex);
    }
    ray.set(new THREE.Vector3(0,.2,3),new THREE.Vector3(0,0,-1));
    const bridge=ray.intersectObject(gltf.scene,true)[0]?.face.materialIndex;
    const materials=mesh.material,unknown={asset:{extras:{}},scene:gltf.scene};
    const normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),normal=new THREE.Vector3();
    const lensGroup=mesh.geometry.groups[1];let minLensNormalZ=1;
    for(let i=lensGroup.start;i<lensGroup.start+lensGroup.count;i++){
      normal.fromBufferAttribute(mesh.geometry.attributes.normal,mesh.geometry.index.getX(i)).applyMatrix3(normalMatrix).normalize();
      minLensNormalZ=Math.min(minLensNormalZ,normal.z);
    }
    const unknownUntouched=prepareKnownMaterials(unknown)===null&&mesh.material===materials;
    const repeatUntouched=prepareKnownMaterials(gltf)===null&&mesh.material===materials;
    return {profile,originalCount,count:mesh.geometry.index.count,unchanged,hits,bridge,unknownUntouched,repeatUntouched,
      groups:mesh.geometry.groups,lensTransparent:materials[1].transparent,lensOpacity:materials[1].opacity,
      sourceColoursPreserved:materials[0].map===sourceColour&&materials[1].map===sourceColour&&!sourceDisposed,
      frameNormalsPreserved:sourceNormals.every((v,i)=>v===mesh.geometry.attributes.normal.array[i]),minLensNormalZ,
      noBakedNormalMaps:!materials[0].normalMap&&!materials[1].normalMap,frameOpaque:!materials[0].transparent};
  },process.env.TRYON_MODEL_URL||'/products/head-12028/head-12028-generated.glb');
  assert.ok(report.profile);assert.equal(report.count,report.originalCount);assert.ok(report.unchanged);
  assert.equal(report.groups.reduce((n,g)=>n+g.count,0),report.count);
  assert.ok(report.hits.every(i=>i===1),'lens interiors must contain no opaque baked-reflection islands');
  assert.equal(report.bridge,0,'bridge stays opaque');
  assert.ok(report.lensTransparent&&report.lensOpacity>=.9&&report.lensOpacity<1&&report.noBakedNormalMaps&&report.frameOpaque);
  assert.ok(report.sourceColoursPreserved&&report.frameNormalsPreserved&&report.minLensNormalZ>.95,'keep original frame detail and use coherent smooth lens normals');
  assert.ok(report.unknownUntouched&&report.repeatUntouched);
  console.log('PASS: real model lens interiors are optical surfaces, bridge remains opaque, geometry/triangle count preserved, unrelated uploads unchanged.');
  console.log({lensTriangles:report.profile.lensTriangles,frameTriangles:report.profile.frameTriangles});
} finally {await browser?.close();child.kill();}
