import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importProduct} from '../scripts/import-head-12028.mjs';

test('photo model import adds a valid self-contained GLB, preserves products and is repeatable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caba-import-'));
 try{
  await fs.mkdir(path.join(root,'data'));
  const original={id:'original',name:'Existing product',visible:false};
  await fs.writeFile(path.join(root,'data/catalog.json'),JSON.stringify([original]));
  await fs.mkdir(path.join(root,'public/products'),{recursive:true});
  await fs.cp(new URL('../public/products/head-12028',import.meta.url),path.join(root,'public/products/head-12028'),{recursive:true});
  assert.equal(await importProduct(root),true);
  const items=JSON.parse(await fs.readFile(path.join(root,'data/catalog.json'),'utf8'));
  assert.deepEqual(items[0],original);assert.equal(items.length,2);
  const product=items[1];assert.equal(product.name,'12029');assert.equal(product.estimatedDimensions,true);
  const glb=await fs.readFile(path.join(root,product.model));
  assert.equal(glb.readUInt32LE(8),glb.length);
  const json=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString());
  assert.ok(json.meshes.length>=5);
  assert.ok(json.buffers.every(b=>!b.uri));
  assert.ok(!json.images?.length);
  assert.deepEqual(json.asset.extras.lunetteCaba.anchor,[0,-.004,0]);
  assert.ok((await fs.stat(path.join(root,product.image))).size>0);
  product.visible=false;product.name='My edited name';
  await fs.writeFile(path.join(root,'data/catalog.json'),JSON.stringify(items));
  const before=await fs.readFile(path.join(root,'data/catalog.json'),'utf8');
  assert.equal(await importProduct(root),false);
  assert.equal(await fs.readFile(path.join(root,'data/catalog.json'),'utf8'),before);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
