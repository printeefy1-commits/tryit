import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3199',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3199');
  const report=await page.evaluate(async(modelUrl)=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js');
    const {prepareKnownTempleFit}=await import('/tryon-ears.js');
    const {prepareTempleVisibility,updateTempleVisibility}=await import('/tryon-temple-visibility.js');
    const gltf=await new GLTFLoader().loadAsync(modelUrl);
    prepareKnownMaterials(gltf);prepareKnownTempleFit(gltf);
    const control=prepareTempleVisibility(gltf),profile=gltf.asset.extras.lunetteCaba;
    const repeatSame=prepareTempleVisibility(gltf)===control;
    const unknown=prepareTempleVisibility({scene:{userData:{}}})===null;
    gltf.scene.position.sub(new THREE.Vector3(...profile.anchor));
    const wrapper=new THREE.Group();wrapper.add(gltf.scene);wrapper.scale.setScalar(1/profile.referenceWidth);
    const model=new THREE.Group();model.add(wrapper);model.scale.setScalar(14);model.position.z=-40;model.userData.templeVisibility=control;model.updateMatrixWorld(true);
    const arm=control.arms[0],full=arm.group.count,otherFull=control.arms[1].group.count;
    updateTempleVisibility(model,[]);const empty=arm.group.count===full;
    const point=model.localToWorld(arm.samples[8].point.clone()),direction=point.clone().normalize();
    const mask=new THREE.Mesh(new THREE.PlaneGeometry(.5,.5),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
    mask.position.copy(point).addScaledVector(direction,-.3);mask.updateMatrixWorld(true);
    updateTempleVisibility(model,[mask]);
    const clipped=arm.group.count,cutoff=arm.cutoff,nearIntact=control.arms[1].group.count===otherFull;
    const ray=new THREE.Raycaster();
    const reentry=arm.samples.some(s=>{if(s.distance<=cutoff+1)return false;const p=model.localToWorld(s.point.clone());ray.set(new THREE.Vector3(),p.clone().normalize());ray.far=p.length()-.06;return !ray.intersectObject(mask).length;});
    const prefix=arm.ends.slice(0,clipped/3).every(d=>d<=cutoff)&&arm.ends.slice(clipped/3).every(d=>d>cutoff);
    updateTempleVisibility(model,[]);const restored=arm.group.count===full;
    const {createFaceOccluder,createHeadOccluder,updateRigidOccluders,cameraDirectionInHead}=await import('/tryon-fit.js');
    const {createEarOccluders,updateEarOccluders}=await import('/tryon-ears.js');
    const {estimatePerspectiveFit,projectCameraPoint}=await import('/tryon-perspective.js');
    const canonical=(await(await fetch('/models/canonical-face.json')).json()).vertices,triangles=(await(await fetch('/models/face-topology.json')).json()).triangles;
    const faceMask=createFaceOccluder(triangles),head=createHeadOccluder(),ears=createEarOccluders(),integration=[];
    for(const side of [-1,1])for(const [pitch,yaw,roll,ty] of [[.2,.6,.25,-2],[.5,.4,.3,-4]]){
      const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,side*yaw,side*roll)),t=new THREE.Vector3(0,ty,-40);
      const face=canonical.map(v=>({...projectCameraPoint(new THREE.Vector3(...v).applyQuaternion(q).add(t)),z:0}));
      const fit=estimatePerspectiveFit(face,1,{data:new THREE.Matrix4().makeRotationFromQuaternion(q).toArray()},canonical);
      updateRigidOccluders(faceMask,head,face,1,fit);updateEarOccluders(ears,fit);
      model.position.copy(fit.position);model.quaternion.copy(fit.quaternion);updateTempleVisibility(model,[faceMask,head,ears]);
      const near=cameraDirectionInHead(fit).x<0?0:1;
      const nearEarCutoff=control.arms[near].earCutoff,nearCutoff=control.arms[near].cutoff,farCutoff=control.arms[1-near].cutoff,isolated={};
      for(const [name,mask] of [['face',faceMask],['head',head],['ears',ears]]){updateTempleVisibility(model,[mask]);isolated[name]=control.arms[near].cutoff;}
      integration.push({side,pitch,nearCutoff,nearEarCutoff,farCutoff,isolated});
    }
    return {empty,clipped,full,cutoff,nearIntact,reentry,prefix,restored,integration,repeatSame,unknown};
  },process.env.TRYON_MODEL_URL||'/products/head-12028/head-12028-generated.glb');
  assert.ok(report.empty&&report.restored&&report.nearIntact&&report.repeatSame&&report.unknown);
  assert.ok(report.clipped>0&&report.clipped<report.full&&Number.isFinite(report.cutoff));
  assert.ok(report.reentry&&report.prefix,'a later exposed fragment must stay clipped after the first occlusion');
  for(const r of report.integration)assert.ok(Number.isFinite(r.nearEarCutoff)&&r.nearCutoff>=r.nearEarCutoff-.35,'extended near shaft must reach the rearward upper-ear support before clipping: '+JSON.stringify(r));
  console.log('PASS: continuous temple prefix clips reappearing rear islands, preserves the opposite shaft, and restores the full arm when clear.');
  console.log(report);
} finally {await browser?.close();child.kill();}
