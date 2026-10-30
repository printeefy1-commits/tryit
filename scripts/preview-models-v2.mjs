// Authoring helper: render the shipped asset with the same material/temple
// preparation and lighting as the camera view. No physical dimensions implied.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3202',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3202');
  const result=await page.evaluate(async()=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {RoomEnvironment}=await import('three/addons/environments/RoomEnvironment.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js'),{prepareKnownTempleFit}=await import('/tryon-ears.js');
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(900,650);
    const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(room,.04);
    const images={};let profile;
    for(const [name,position,prepared] of [
      ['source-front',[0,.135,3],false],['front',[0,.135,3],true],['oblique',[1.8,1.1,3],true],['side',[3,.5,.5],true]
    ]){
      const gltf=await new GLTFLoader().loadAsync('/products/models-v2/head-blue.glb');
      if(prepared){profile=prepareKnownMaterials(gltf);prepareKnownTempleFit(gltf);}
      const scene=new THREE.Scene();scene.background=new THREE.Color(0xefefe8);scene.environment=environment.texture;scene.add(gltf.scene);
      scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1));
      const light=new THREE.DirectionalLight(0xffffff,.8);light.position.set(0,2,5);scene.add(light);
      const camera=new THREE.OrthographicCamera(-.76,.76,.549,-.549,.01,100);camera.position.set(...position);camera.lookAt(0,.135,-.12);
      renderer.render(scene,camera);images[name]=renderer.domElement.toDataURL();
      gltf.scene.traverse(node=>{if(node.isMesh){node.geometry.dispose();for(const m of Array.isArray(node.material)?node.material:[node.material]){for(const t of Object.values(m))if(t?.isTexture)t.dispose();m.dispose();}}});
    }
    renderer.dispose();room.dispose();environment.dispose();pmrem.dispose();return {images,profile};
  });
  if(errors.length)throw Error(errors.join('\n'));
  const output=process.env.PREVIEW_DIR||'/tmp/tryit-models-v2-preview';await fs.mkdir(output,{recursive:true});
  for(const [name,url] of Object.entries(result.images))await fs.writeFile(`${output}/${name}.png`,Buffer.from(url.split(',')[1],'base64'));
  console.log(JSON.stringify({output,profile:result.profile}));
}finally{await browser?.close();child.kill();}
