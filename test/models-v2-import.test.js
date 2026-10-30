import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importModels} from '../scripts/import-models-v2.mjs';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caba-models-v2-'));
  await fs.mkdir(path.join(root,'data'));await fs.mkdir(path.join(root,'public/products'),{recursive:true});
  await fs.cp(new URL('../public/products/models-v2',import.meta.url),path.join(root,'public/products/models-v2'),{recursive:true});
  const existing={id:'head-12028-col400',name:'Owner name',brand:'HEAD',visible:false,scale:.91,offset:.07,model:'/uploads/owner.glb',image:'/uploads/owner.jpg'};
  await fs.writeFile(path.join(root,'data/catalog.json'),JSON.stringify([existing]));
  return {root,existing,db:path.join(root,'data/catalog.json')};
}

test('models-v2 adds a textured standalone model without modifying existing products; repeats preserve admin edits',async()=>{
  const {root,existing,db}=await fixture();
  try{
    assert.equal(await importModels(root),true);
    const products=JSON.parse(await fs.readFile(db));assert.deepEqual(products[0],existing);assert.equal(products.length,2);
    const p=products[1];assert.equal(p.id,'head-12028-models-v2');assert.equal(p.name,'12028');assert.equal(p.estimatedDimensions,true);
    assert.equal(p.frameWidthMm,undefined,'do not invent a measured width');
    const bytes=await fs.readFile(path.join(root,p.model));
    assert.deepEqual(bytes,await fs.readFile(path.join(root,'public/products/models-v2/head-blue.glb')));
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
    assert.equal(gltf.asset.extras.lunetteCaba.sourceSha256,p.sourceSha256);
    assert.ok(!gltf.images?.length,'authored revision uses material colours without baked textures');
    assert.deepEqual(gltf.materials.map(m=>m.name).sort(),['Blue_Lenses','frame']);
    assert.ok((await fs.stat(path.join(root,p.image))).size>0);
    p.name='Administrator model name';p.visible=false;p.scale=.95;p.frameWidthMm=142;
    await fs.writeFile(db,JSON.stringify(products));const before=await fs.readFile(db);
    assert.equal(await importModels(root),false);assert.deepEqual(await fs.readFile(db),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('models-v2 corrects only the original model-v1 display name while preserving its identity and settings',async()=>{
  const {root,existing,db}=await fixture();
  try{
    const original={...existing,name:'12028'};
    await fs.writeFile(db,JSON.stringify([original]));await importModels(root);
    let products=JSON.parse(await fs.readFile(db));
    assert.deepEqual(products[0],{...original,name:'12029'});
    assert.equal(products[1].name,'12028');assert.notEqual(products[0].model,products[1].model);
    // Correct the label even when the new product was already imported.
    products[0].name='HEAD 12028';await fs.writeFile(db,JSON.stringify(products));
    assert.equal(await importModels(root),true);
    products=JSON.parse(await fs.readFile(db));assert.equal(products[0].name,'HEAD 12029');
    assert.equal(products.length,2);
    const before=await fs.readFile(db);assert.equal(await importModels(root),false);assert.deepEqual(await fs.readFile(db),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('models-v2 rejects invalid provenance before changing the catalogue',async()=>{
  const {root,db}=await fixture();
  try{
    const manifest=path.join(root,'public/products/models-v2/catalog.json'),entries=JSON.parse(await fs.readFile(manifest));
    entries[0].sourceSha256='incorrect';await fs.writeFile(manifest,JSON.stringify(entries));
    const before=await fs.readFile(db);
    await assert.rejects(()=>importModels(root),/provenance mismatch/);assert.deepEqual(await fs.readFile(db),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
