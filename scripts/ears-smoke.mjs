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
  const report=await page.evaluate(async()=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {prepareKnownTempleFit,createEarOccluders,updateEarOccluders}=await import('/tryon-ears.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js');
    const {CAMERA_FOV,projectCameraPoint}=await import('/tryon-perspective.js');
    const gltf=await new GLTFLoader().loadAsync('/products/head-12028/head-12028-generated.glb');
    prepareKnownMaterials(gltf);
    let mesh;gltf.scene.traverse(o=>{if(o.isMesh)mesh=o;});gltf.scene.updateMatrixWorld(true);
    const positions=mesh.geometry.attributes.position.array.slice(),uv=mesh.geometry.attributes.uv.array.slice();
    const normals=mesh.geometry.attributes.normal.array.slice(),tangents=mesh.geometry.attributes.tangent.array.slice();
    const indices=mesh.geometry.index.array.slice(),material=mesh.material;
    const lensVertices=new Set();for(const group of mesh.geometry.groups)if(group.materialIndex===1){
      for(let j=group.start;j<group.start+group.count;j++)lensVertices.add(indices[j]);
    }
    const adjustment=prepareKnownTempleFit(gltf),after=mesh.geometry.attributes.position;
    const profile=gltf.asset.extras.lunetteCaba,anchor=new THREE.Vector3(...profile.anchor),scale=14/profile.referenceWidth;
    let unchangedFront=true,unchangedFrontShading=true,maxLift=0,minLift=Infinity,xzDrift=0;
    const supportHeights=[];
    for(let i=0;i<after.count;i++){
      const before=new THREE.Vector3().fromArray(positions,i*3).applyMatrix4(mesh.matrixWorld).sub(anchor).multiplyScalar(scale).add(new THREE.Vector3(0,2.625,5.5));
      const point=new THREE.Vector3().fromBufferAttribute(after,i).applyMatrix4(mesh.matrixWorld).sub(anchor).multiplyScalar(scale).add(new THREE.Vector3(0,2.625,5.5));
      if(lensVertices.has(i)||before.z>=4||Math.abs(before.x)<=5.3){
        unchangedFront&&=positions[i*3]===after.getX(i)&&positions[i*3+1]===after.getY(i)&&positions[i*3+2]===after.getZ(i);
        for(let j=0;j<3;j++)unchangedFrontShading&&=normals[i*3+j]===mesh.geometry.attributes.normal.array[i*3+j];
        for(let j=0;j<4;j++)unchangedFrontShading&&=tangents[i*4+j]===mesh.geometry.attributes.tangent.array[i*4+j];
      }
      maxLift=Math.max(maxLift,point.y-before.y);minLift=Math.min(minLift,point.y-before.y);
      xzDrift=Math.max(xzDrift,Math.abs(point.x-before.x),Math.abs(point.z-before.z));
      if(Math.abs(before.x)>5.5&&before.z> -5&&before.z< -4)supportHeights.push(point.y);
    }
    const repeat=prepareKnownTempleFit(gltf),unknown=prepareKnownTempleFit({asset:{extras:{}},scene:gltf.scene});
    const preserved=indices.every((n,i)=>n===mesh.geometry.index.array[i])&&uv.every((n,i)=>n===mesh.geometry.attributes.uv.array[i])&&material===mesh.material;
    const scene=new THREE.Scene(),ears=createEarOccluders();scene.add(ears);
    const probe=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4),new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));scene.add(probe);
    const camera=new THREE.PerspectiveCamera(CAMERA_FOV,1,.1,500),renderer=new THREE.WebGLRenderer({alpha:true,antialias:false});
    renderer.setSize(480,480);const target=new THREE.WebGLRenderTarget(480,480);renderer.setRenderTarget(target);
    const probes=[];
    for(const side of [-1,1])for(const roll of [0,.3]){
      const fit={translation:new THREE.Vector3(0,0,-40),quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,-side*1,side*roll)),metricScale:1};
      updateEarOccluders(ears,fit);
      for(const [name,local,hidden] of [
        ['hook behind ear',[side*6.2,2.8,-5.8],true],
        ['shaft above ear',[side*6.9,4.85,-5.8],false],
        ['temple ahead of ear',[side*6.7,4.2,-2.7],false]
      ]){
        probe.position.set(...local).applyQuaternion(fit.quaternion).add(fit.translation);
        const screen=projectCameraPoint(probe.position),pixel=new Uint8Array(4);
        const visible=masked=>{ears.visible=masked;renderer.render(scene,camera);renderer.readRenderTargetPixels(target,Math.floor(screen.x*480),Math.floor((1-screen.y)*480),1,1,pixel);return pixel[3]>200;};
        probes.push({name,side,roll,hidden,unmasked:visible(false),masked:visible(true)});
      }
    }
    renderer.dispose();target.dispose();
    return {adjustment,unchangedFront,unchangedFrontShading,maxLift,minLift,xzDrift,preserved,repeat,unknown,
      minimumSupportHeight:Math.min(...supportHeights),probes};
  });
  assert.ok(report.adjustment?.movedVertices>1000);assert.ok(report.unchangedFront&&report.unchangedFrontShading&&report.preserved);
  assert.ok(report.maxLift>1.3&&report.maxLift<1.351&&report.minLift> -1e-5&&report.xzDrift<1e-5);
  assert.ok(report.minimumSupportHeight>4,'temple should approach the upper ear rather than its opening');
  assert.equal(report.repeat,null);assert.equal(report.unknown,null);
  for(const probe of report.probes){
    assert.ok(probe.unmasked,`${probe.name}: reference probe must be visible`);
    assert.equal(probe.masked,!probe.hidden,`${probe.name}, side ${probe.side}, roll ${probe.roll}: wrong ear occlusion`);
  }
  console.log('PASS: rear temples rise toward the upper ear; front/lenses, UVs and materials stay intact; ear masks hide rear hooks and preserve shafts above/in front of ears on both sides.');
  console.log({movedVertices:report.adjustment.movedVertices,maxLiftCm:report.maxLift,probes:report.probes.length});
} finally {await browser?.close();child.kill();}
