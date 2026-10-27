import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {upgradeProduct} from '../scripts/upgrade-head-12028.mjs';

test('generated GLB upgrade preserves custom product settings and previous model; repeat is safe',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caba-upgrade-'));
 try{
  await fs.mkdir(path.join(root,'data'));await fs.mkdir(path.join(root,'public/products/head-12028'),{recursive:true});
  const asset=await fs.readFile(new URL('../public/products/head-12028/head-12028-generated.glb',import.meta.url));
  await fs.writeFile(path.join(root,'public/products/head-12028/head-12028-generated.glb'),asset);
  const original={id:'head-12028-col400',name:'Custom name',brand:'HEAD',visible:false,scale:.91,offset:.07,image:'/uploads/my-image.jpg',model:'/uploads/old.glb'};
  const unrelated={id:'other',model:'/uploads/other.glb'};
  await fs.writeFile(path.join(root,'data/catalog.json'),JSON.stringify([original,unrelated]));
  assert.equal(await upgradeProduct(root),true);
  const updated=JSON.parse(await fs.readFile(path.join(root,'data/catalog.json'),'utf8'));
  for(const key of ['id','name','brand','visible','scale','offset','image'])assert.deepEqual(updated[0][key],original[key]);
  assert.equal(updated[0].previousModel,original.model);assert.equal(updated[0].estimatedDimensions,true);
  assert.deepEqual(updated[1],unrelated);
  assert.deepEqual(await fs.readFile(path.join(root,updated[0].model)),asset);
  assert.ok(asset.length<25*1024*1024);
  const jsonLength=asset.readUInt32LE(12),glb=JSON.parse(asset.subarray(20,20+jsonLength));
  const fitting=glb.asset.extras.lunetteCaba;
  assert.deepEqual(fitting.anchor,[-.00085,.14,.2114]);
  assert.equal(fitting.sourceSha256,'20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055');
  assert.equal(glb.images.length,3);assert.ok(glb.images.every(i=>i.bufferView!==undefined&&!i.uri));
  for(const mesh of glb.meshes)for(const p of mesh.primitives){assert.ok(p.attributes.TANGENT!==undefined);assert.ok(glb.accessors[p.indices].count<=75000*3)}
  const before=await fs.readFile(path.join(root,'data/catalog.json'),'utf8');
  assert.equal(await upgradeProduct(root),false);
  assert.equal(await fs.readFile(path.join(root,'data/catalog.json'),'utf8'),before);
  await fs.writeFile(path.join(root,'data/catalog.json'),JSON.stringify([unrelated]));
  await assert.rejects(()=>upgradeProduct(root),/not present/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'data/catalog.json'),'utf8')),[unrelated]);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
