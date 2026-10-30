// Render both reviewed products against the canonical face and ear template.
// Synthetic geometry verifies attachment/occlusion; it is not a measurement of
// the owner's actual ears or a claim of pixel-accurate ear segmentation.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3211',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const urls=process.env.TRYON_MODEL_URL?[process.env.TRYON_MODEL_URL]:['/products/head-12028/head-12028-generated.glb','/products/models-v2/head-blue.glb'];
 if(process.env.OPTIMIZED_MODEL_FIXTURE){const bytes=await fs.readFile(process.env.OPTIMIZED_MODEL_FIXTURE);await page.route('**/support-fixture.glb',route=>route.fulfill({body:bytes,contentType:'model/gltf-binary'}));urls.splice(0,urls.length,'/support-fixture.glb');}
 await page.goto('http://127.0.0.1:3211');
 const result=await page.evaluate(async({urls,unknown})=>{
  const THREE=await import('three'),{createModelLoader}=await import('/model-loader.js'),{prepareGlasses}=await import('/prepare-glasses.js');
  const {createFaceOccluder,createHeadOccluder,updateRigidOccluders,cameraDirectionInHead}=await import('/tryon-fit.js');
  const {createEarOccluders,updateEarOccluders,EAR_TEMPLATE,TEMPLE_SUPPORT}=await import('/tryon-ears.js');
  const {updateTempleVisibility}=await import('/tryon-temple-visibility.js');
  const {estimatePerspectiveFit,projectCameraPoint,CAMERA_FOV}=await import('/tryon-perspective.js');
  const {RoomEnvironment}=await import('three/addons/environments/RoomEnvironment.js');
  const canonical=(await(await fetch('/models/canonical-face.json')).json()).vertices,triangles=(await(await fetch('/models/face-topology.json')).json()).triangles;
  const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(800,800);
  const camera=new THREE.PerspectiveCamera(CAMERA_FOV,1,.1,500),room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(room,.04);
  const output=[];
  for(const url of urls){
   const gltf=await createModelLoader().loadAsync(url);
   if(unknown)delete gltf.asset.extras;
   const model=prepareGlasses(gltf),control=model.userData.templeVisibility;
   if(unknown&&model.userData.fitting.templeFit?.method!=='geometry')throw Error('Admin upload must actually activate geometry fitting');
   if(!control?.arms.length)throw Error('Fixture must have temple control');
   const scene=new THREE.Scene();scene.background=new THREE.Color(0xedf1f5);scene.environment=environment.texture;scene.add(model);
   scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1.5));const light=new THREE.DirectionalLight(0xffffff,1);light.position.set(0,2,5);scene.add(light);
   const faceMask=createFaceOccluder(triangles),head=createHeadOccluder(),ears=createEarOccluders();scene.add(faceMask,head,ears);
   const skinGeometry=new THREE.BufferGeometry();skinGeometry.setAttribute('position',new THREE.Float32BufferAttribute(canonical.flat(),3));skinGeometry.setIndex(triangles.flat());skinGeometry.computeVertexNormals();
   const skinMaterial=new THREE.MeshStandardMaterial({color:0xcda789,roughness:.8,side:THREE.DoubleSide}),skin=new THREE.Mesh(skinGeometry,skinMaterial),earSkin=new THREE.Group();
   for(const ear of ears.children)earSkin.add(new THREE.Mesh(ear.geometry.clone(),skinMaterial));scene.add(skin,earSkin);
   const views=[];
   for(const [name,pitch,yaw,roll] of [['right',.1,1,.1],['left',.1,-1,-.1],['right-down',.5,.5,.3],['left-down',.5,-.5,-.3],['down',1,0,0],['up',-.8,0,0]]){
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,roll)),translation=new THREE.Vector3(0,-1,-30);
    const face=canonical.map(v=>({...projectCameraPoint(new THREE.Vector3(...v).applyQuaternion(q).add(translation)),z:0}));
    const fit=estimatePerspectiveFit(face,1,{data:new THREE.Matrix4().makeRotationFromQuaternion(q).toArray()},canonical);
    model.position.copy(fit.position);model.quaternion.copy(fit.quaternion);model.scale.setScalar(fit.width);
    skin.position.copy(fit.translation);skin.quaternion.copy(fit.quaternion);earSkin.position.copy(fit.translation);earSkin.quaternion.copy(fit.quaternion);
    updateRigidOccluders(faceMask,head,face,1,fit);updateEarOccluders(ears,fit);updateTempleVisibility(model,[faceMask,head,ears]);
    const near=cameraDirectionInHead(fit).x<0?-1:1;
    const ends=control.arms.map(arm=>{
     const visibleEnds=arm.ends.slice(0,arm.group.count/3);
     return {side:arm.side,earCutoff:arm.earCutoff,cutoff:arm.cutoff,visible:arm.group.count/3,
       maxVisibleDistance:visibleEnds.length?visibleEnds.reduce((maximum,end)=>Math.max(maximum,end),0):0,full:arm.ends.length};
    });
    renderer.render(scene,camera);views.push({name,near,ends,png:renderer.domElement.toDataURL()});
   }
   output.push({url,views,contactZ:TEMPLE_SUPPORT.contactZ,earTopY:EAR_TEMPLATE.y+EAR_TEMPLATE.radiusY});
   const geometries=new Set(),materials=new Set(),textures=new Set();scene.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of Array.isArray(node.material)?node.material:node.material?[node.material]:[]){materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}});for(const value of [...geometries,...materials,...textures])value.dispose();
  }
  renderer.dispose();room.dispose();environment.dispose();pmrem.dispose();return output;
 },{urls,unknown:!!process.env.UNKNOWN_MODEL});
 const output=process.env.SUPPORT_PREVIEW_DIR||'/tmp/tryit-temple-support';await fs.mkdir(output,{recursive:true});
 for(const [index,product] of result.entries())for(const view of product.views){
  for(const arm of view.ends){assert.ok(Number.isFinite(arm.earCutoff),'rear hook must have an anatomical end at the ear');assert.ok(arm.cutoff<=arm.earCutoff+1e-6);assert.ok(arm.maxVisibleDistance<=arm.cutoff+1e-6,'no isolated triangle may survive behind the ear');}
  if(['right','left','right-down','left-down'].includes(view.name)){const near=view.ends.find(arm=>arm.side===view.near);assert.ok(near.visible>100&&near.cutoff>10,'near shaft must remain connected as far as the upper ear: '+JSON.stringify({url:product.url,view:view.name,near}));}
  await fs.writeFile(`${output}/${index}-${view.name}.png`,Buffer.from(view.png.split(',')[1],'base64'));delete view.png;
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({output,products:result},null,2));
 console.log('PASS: actual products reach the upper-ear support on both sides, clip rear hooks continuously, and preserve near shafts in lateral/downward poses.');
}finally{await browser?.close();child.kill();}
