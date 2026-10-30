// Optional reference GLB stays outside Git. Compare the same source under the
// same camera/material preparation at three angles, then exercise the decoder.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {optimizeModel} from '../model-optimizer.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const fixture=process.env.OPTIMIZE_GLB_FIXTURE||new URL('../public/products/models-v2/head-blue.glb',import.meta.url).pathname;
const source=await fs.readFile(fixture),hash=crypto.createHash('sha256').update(source).digest('hex');
const dir=await fs.mkdtemp('/tmp/tryit-optimization-'),optimized=dir+'/web.glb',report=await optimizeModel(fixture,optimized),bytes=await fs.readFile(optimized);
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3208',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/optimization-source.glb',route=>route.fulfill({body:source,contentType:'model/gltf-binary'}));
 await page.route('**/optimization-web.glb',route=>route.fulfill({body:bytes,contentType:'model/gltf-binary'}));
 await page.goto('http://127.0.0.1:3208');
 const result=await page.evaluate(async({hash})=>{
  const THREE=await import('three'),{createModelLoader}=await import('/model-loader.js'),{prepareGlasses}=await import('/prepare-glasses.js'),{RoomEnvironment}=await import('three/addons/environments/RoomEnvironment.js');
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(700,500);renderer.setPixelRatio(1);
  const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(room,.04),images={},fittings=[],bounds=[],optics=[],arms=[];
  for(const name of ['source','web']){
   const gltf=await createModelLoader().loadAsync('/optimization-'+name+'.glb'),model=prepareGlasses(gltf,{sourceSha256:hash});
   fittings.push(model.userData.fitting);bounds.push(new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).toArray());optics.push(model.userData.opticalProfile?.authoredMaterials||false);arms.push(model.userData.templeVisibility?.arms.length||0);
   const scene=new THREE.Scene();scene.background=new THREE.Color(0xedf1f5);scene.environment=env.texture;scene.add(model);scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1));
   const light=new THREE.DirectionalLight(0xffffff,.8);light.position.set(0,2,5);scene.add(light);
   for(const [angle,position] of [['front',[0,0,1.8]],['oblique',[1.2,.55,1.7]],['side',[1.9,.15,.25]]]){
    const camera=new THREE.PerspectiveCamera(35,1.4,.01,100);camera.position.set(...position);camera.lookAt(0,0,-.25);renderer.render(scene,camera);images[name+'-'+angle]=renderer.domElement.toDataURL();
   }
   const geometries=new Set(),materials=new Set(),textures=new Set();model.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of Array.isArray(node.material)?node.material:node.material?[node.material]:[]){materials.add(material);for(const texture of Object.values(material))if(texture?.isTexture)textures.add(texture);}});for(const resource of [...geometries,...materials,...textures])resource.dispose();
  }
  renderer.dispose();env.dispose();room.dispose();pmrem.dispose();return {images,fittings,bounds,optics,arms};
 },{hash});
 assert.deepEqual(errors,[]);assert.deepEqual(result.fittings[0],result.fittings[1],'fitting anchor and width retained');assert.deepEqual(result.optics,[result.optics[0],result.optics[0]]);assert.equal(result.arms[0],result.arms[1],'temple controller retained');
 for(let axis=0;axis<3;axis++)assert.ok(Math.abs(result.bounds[0][axis]-result.bounds[1][axis])<.005,'bounds remain within 0.5% of frame width');
 const metrics={};
 for(const angle of ['front','oblique','side']){
  const images=[];
  for(const name of ['source','web']){const png=Buffer.from(result.images[name+'-'+angle].split(',')[1],'base64');await fs.writeFile(dir+'/'+name+'-'+angle+'.png',png);images.push(await sharp(png).removeAlpha().raw().toBuffer());}
  let error=0,changed=0;for(let i=0;i<images[0].length;i++){const delta=images[0][i]-images[1][i];error+=delta*delta;if(Math.abs(delta)>20)changed++;}
  const rmse=Math.sqrt(error/images[0].length);metrics[angle]={rmse,changedFraction:changed/images[0].length};
  assert.ok(rmse<10,angle+' render differs excessively (RMSE '+rmse+')');
 }
 console.log(JSON.stringify({report,metrics,output:dir,fittings:result.fittings,arms:result.arms},null,2));
 console.log('PASS: actual optimized GLB decodes in browser, preserves reviewed fitting and temple controllers, and renders close to its source in three views.');
}finally{await browser?.close();child.kill();}
