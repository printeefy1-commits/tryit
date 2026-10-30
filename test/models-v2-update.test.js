import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {updateModels} from '../scripts/update-models-v2.mjs';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caba-v2-update-'));
  await fs.mkdir(path.join(root,'data'));await fs.mkdir(path.join(root,'uploads'));await fs.mkdir(path.join(root,'public/products'),{recursive:true});
  await fs.cp(new URL('../public/products/models-v2',import.meta.url),path.join(root,'public/products/models-v2'),{recursive:true});
  const original={id:'head-12028-models-v2',name:'Custom name',brand:'HEAD',visible:false,scale:.93,offset:.08,frameWidthMm:143,
    estimatedDimensions:false,model:'/uploads/previous-v2.glb',image:'/uploads/head-12028-models-v2-52539ea643f085c8.webp',
    sourceSha256:'a013cbe08e711629e2a47a62560ca87b625dca8a0f20bdd4c6eae92f67c51514'};
  const legacy={id:'head-12028-col400',name:'12029',model:'/uploads/v1.glb',visible:true,scale:1.1};
  const db=path.join(root,'data/catalog.json');await fs.writeFile(db,JSON.stringify([legacy,original]));
  await fs.writeFile(path.join(root,'uploads/previous-v2.glb'),'preserved original model');
  return {root,db,original,legacy};
}

test('revised models-v2 replaces the existing GLB, refreshes its generated preview and preserves settings, old files and model-v1',async()=>{
  const {root,db,original,legacy}=await fixture();
  try{
    assert.equal(await updateModels(root),true);
    const items=JSON.parse(await fs.readFile(db));assert.equal(items.length,2);assert.deepEqual(items[0],legacy);
    const p=items[1];
    for(const key of ['id','name','brand','visible','scale','offset','frameWidthMm','estimatedDimensions'])assert.deepEqual(p[key],original[key]);
    assert.equal(p.previousModel,original.model);assert.equal(p.previousModelSourceSha256,original.sourceSha256);
    assert.equal(p.previousImage,original.image);assert.notEqual(p.image,original.image);
    assert.equal(await fs.readFile(path.join(root,original.model),'utf8'),'preserved original model');
    assert.deepEqual(await fs.readFile(path.join(root,p.model)),await fs.readFile(path.join(root,'public/products/models-v2/head-blue.glb')));
    assert.equal(p.sourceSha256,'046f50c9b51e6d12d0956db2d60a4b0566c6d0455e5f2a374d8af939b198e0bf');
    const before=await fs.readFile(db);assert.equal(await updateModels(root),false);assert.deepEqual(await fs.readFile(db),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('revised models-v2 preserves a custom product photo',async()=>{
  const {root,db,original,legacy}=await fixture();
  try{
    original.image='/uploads/owners-photo.jpg';await fs.writeFile(db,JSON.stringify([legacy,original]));
    await updateModels(root);const p=JSON.parse(await fs.readFile(db))[1];
    assert.equal(p.image,original.image);assert.equal(p.previousImage,undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('revised models-v2 rejects missing products and mismatched sources without changing the catalogue',async()=>{
  const {root,db,legacy}=await fixture();
  try{
    const manifest=path.join(root,'public/products/models-v2/catalog.json'),entries=JSON.parse(await fs.readFile(manifest));
    entries[0].sourceSha256='incorrect';await fs.writeFile(manifest,JSON.stringify(entries));
    let before=await fs.readFile(db);await assert.rejects(()=>updateModels(root),/provenance mismatch/);assert.deepEqual(await fs.readFile(db),before);
    await fs.writeFile(db,JSON.stringify([legacy]));before=await fs.readFile(db);
    await assert.rejects(()=>updateModels(root),/import-models-v2/);assert.deepEqual(await fs.readFile(db),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
