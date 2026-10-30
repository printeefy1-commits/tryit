import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3203',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3203');
  const report=await page.evaluate(async()=>{
    const THREE=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js'),{prepareKnownTempleFit}=await import('/tryon-ears.js');
    const {prepareTempleVisibility}=await import('/tryon-temple-visibility.js');
    const gltf=await new GLTFLoader().loadAsync('/products/models-v2/head-blue.glb'),meshes=[];
    gltf.scene.traverse(mesh=>{if(mesh.isMesh)meshes.push(mesh);});
    const before=meshes.map(mesh=>({mesh,material:mesh.material,geometry:mesh.geometry,
      attributes:Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name,a])=>[name,a.array.slice()]))}));
    const profile=prepareKnownMaterials(gltf);
    const materialsPreserved=before.every(({mesh,material,attributes})=>mesh.material.includes(material)
      &&Object.entries(attributes).every(([name,array])=>array.every((v,i)=>v===mesh.geometry.attributes[name].array[i])));
    const repeat=prepareKnownMaterials(gltf);
    const adjustment=prepareKnownTempleFit(gltf);
    const lens=before.find(p=>p.material.name==='Blue_Lenses'),frame=before.find(p=>p.material.name==='frame');
    const lensesUnchanged=Object.entries(lens.attributes).every(([name,array])=>array.every((v,i)=>v===lens.mesh.geometry.attributes[name].array[i]));
    const controls=prepareTempleVisibility(gltf);
    return {profile,materialsPreserved,repeat,adjustment,lensesUnchanged,arms:controls?.arms.length,
      lensTriangles:lens.mesh.geometry.groups.filter(g=>g.materialIndex===1).reduce((n,g)=>n+g.count/3,0),
      totalTriangles:meshes.reduce((n,m)=>n+m.geometry.index.count/3,0),
      lens:{opacity:lens.material.opacity,roughness:lens.material.roughness,clearcoat:lens.material.clearcoat,side:lens.material.side,vertexColors:lens.material.vertexColors},
      frame:{roughness:frame.material.roughness,ior:frame.material.ior,side:frame.material.side,vertexColors:frame.material.vertexColors},
      doubleSide:THREE.DoubleSide};
  });
  assert.ok(report.profile?.authoredMaterials&&report.materialsPreserved&&report.lensesUnchanged);
  assert.equal(report.repeat,null);assert.equal(report.arms,2,'only the frame creates temple controls');
  assert.equal(report.lensTriangles,report.profile.lensTriangles);assert.ok(report.totalTriangles<=75000);
  assert.ok(report.adjustment.movedVertices>1000);
  assert.equal(report.lens.opacity,.5);assert.ok(Math.abs(report.lens.roughness-.14)<1e-6&&Math.abs(report.lens.clearcoat-.08)<1e-6);
  assert.ok(Math.abs(report.frame.roughness-.9)<1e-6);assert.equal(report.frame.ior,1);
  assert.equal(report.lens.side,report.doubleSide);assert.equal(report.frame.side,report.doubleSide);
  assert.ok(report.lens.vertexColors&&report.frame.vertexColors);
  console.log('PASS: authored frame/lens materials, opacity, vertex colours and lens geometry preserved; two frame-only temple controls; web triangle budget respected.');
  console.log(report);
}finally{await browser?.close();child.kill();}
