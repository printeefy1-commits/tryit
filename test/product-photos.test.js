import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {updatePhotos} from '../scripts/update-product-photos.mjs';

test('selected photos map to the correct models, preserve fitting data and repeat without rewriting the catalogue',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caba-product-photos-'));
  try{
    await fs.mkdir(path.join(root,'data'));
    for(const folder of ['head-12028','models-v2']){
      await fs.mkdir(path.join(root,'public/products',folder),{recursive:true});
      const file=folder==='head-12028'?'front.jpg':'product.webp';
      await fs.copyFile(new URL(`../public/products/${folder}/${file}`,import.meta.url),path.join(root,'public/products',folder,file));
    }
    const originals=[
      {id:'head-12028-col400',name:'12029',image:'/uploads/old-v1.jpg',imageFit:'cover',model:'/uploads/v1.glb',scale:1.2,visible:false},
      {id:'head-12028-models-v2',name:'12028',image:'/uploads/preview.webp',model:'/uploads/v2.glb',frameWidthMm:145,offset:.04},
      {id:'other',image:'/uploads/other.jpg'}
    ];
    const db=path.join(root,'data/catalog.json');await fs.writeFile(db,JSON.stringify(originals));
    assert.equal(await updatePhotos(root),true);const items=JSON.parse(await fs.readFile(db));
    assert.deepEqual(items[2],originals[2]);
    for(let i=0;i<2;i++){
      const p=items[i],number=i===0?'12029':'12028',source=i===0?'head-12028/front.jpg':'models-v2/product.webp';
      assert.ok(p.image.startsWith(`/uploads/head-${number}-photo-`));assert.equal(p.imageFit,'contain');
      assert.equal(p.previousImage,originals[i].image);
      const preserved={...p};delete preserved.image;delete preserved.imageFit;delete preserved.previousImage;
      const before={...originals[i]};delete before.image;delete before.imageFit;assert.deepEqual(preserved,before);
      assert.deepEqual(await fs.readFile(path.join(root,p.image)),await fs.readFile(path.join(root,'public/products',source)));
    }
    const before=await fs.readFile(db);assert.equal(await updatePhotos(root),false);assert.deepEqual(await fs.readFile(db),before);
    await fs.writeFile(db,JSON.stringify([originals[0]]));const missing=await fs.readFile(db);
    await assert.rejects(()=>updatePhotos(root),/12028 is not present/);assert.deepEqual(await fs.readFile(db),missing);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
