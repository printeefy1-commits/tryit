import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import express from 'express';
import {createProductImages} from '../product-image-variants.js';
import {productPhotos,productImage,productImageSet} from '../public/product-photos.js';

const root=await fs.mkdtemp('/tmp/tryit-product-images-');
await fs.mkdir(path.join(root,'uploads'));
await fs.mkdir(path.join(root,'public/products'),{recursive:true});
const original=path.join(root,'uploads/photo.heic.jpg');
const width=1200,height=1600,pixels=Buffer.alloc(width*height*3);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
 const i=(y*width+x)*3;pixels[i]=(x+y)%256;pixels[i+1]=(x*3+y)%256;pixels[i+2]=(x+y*2)%256;
}
await sharp(pixels,{raw:{width,height,channels:3}}).jpeg({quality:94}).toFile(original);
const bytes=await fs.readFile(original),sourceHash=crypto.createHash('sha256').update(bytes).digest('hex');
after(()=>fs.rm(root,{recursive:true,force:true}));

test('existing originals get small aspect-preserving WebP variants without catalogue changes or source replacement',async()=>{
 const images=createProductImages(root),thumb=await images.prepare('/uploads/photo.heic.jpg',128);
 const metadata=await sharp(thumb.file).metadata();
 assert.equal(metadata.format,'webp');assert.equal(metadata.width,128);assert.equal(metadata.height,171);
 assert.ok(thumb.size<bytes.length/10,'a thumbnail must not download the original full-resolution photograph');
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(original)).digest('hex'),sourceHash);
 const before=(await fs.stat(thumb.file)).mtimeMs,repeat=await images.prepare('/uploads/photo.heic.jpg',128);
 assert.equal(repeat.file,thumb.file);assert.equal((await fs.stat(repeat.file)).mtimeMs,before,'cached derivatives are reused');
 const full=await images.prepare('/uploads/photo.heic.jpg',1600),fullMetadata=await sharp(full.file).metadata();
 assert.equal(fullMetadata.width,width);assert.equal(fullMetadata.height,height,'small originals are never enlarged');
 assert.ok(!path.basename(thumb.file).includes('photo'),'cache filenames are content-derived');
});

test('concurrent requests for the same derivative share one serialized transformation and a full queue is bounded',async()=>{
 await sharp(original).flop().jpeg({quality:84}).toFile(path.join(root,'uploads/concurrent.jpg'));
 let conversions=0,release;const barrier=new Promise(resolve=>{release=resolve;});
 const images=createProductImages(root,{maxPending:1,onGenerate:async()=>{conversions++;await barrier;}});
 // Use a different size from the previous test so no disk variant exists yet.
 const requests=Array.from({length:8},()=>images.prepare('/uploads/concurrent.jpg',800));
 while(conversions===0)await new Promise(resolve=>setTimeout(resolve,5));
 await assert.rejects(images.prepare('/uploads/concurrent.jpg',1600),error=>error.status===503);
 release();const ready=await Promise.all(requests);
 assert.equal(conversions,1);assert.ok(ready.every(item=>item.file===ready[0].file));
});

test('source validation confines reads to photo files under uploads or public/products, including realpath checks',async()=>{
 const images=createProductImages(root),outside=path.join(root,'private.jpg');await fs.copyFile(original,outside);
 await fs.symlink(outside,path.join(root,'uploads/escape.jpg'));
 for(const src of ['../../etc/passwd','/uploads/../private.jpg','/uploads/%2e%2e/private.jpg','https://example.com/p.jpg','/data/private.jpg','/uploads/x.glb','/uploads/escape.jpg',null,['/uploads/photo.heic.jpg']]){
  await assert.rejects(images.prepare(src,128),error=>[400,404].includes(error.status),String(src));
 }
 for(const size of [0,127,256,1601,NaN])await assert.rejects(images.prepare('/uploads/photo.heic.jpg',size),error=>error.status===400);
 await fs.writeFile(path.join(root,'uploads/bad.png'),'not an image');
 await assert.rejects(images.prepare('/uploads/bad.png',128),error=>error.status===422);
 assert.ok(!(await fs.readdir(path.join(root,'data/image-cache-v1'))).some(file=>file.endsWith('.tmp')),'failed transforms leave no partial cache entries');
});

test('public product photo edits invalidate derivatives while immutable uploads get long cache and conditional responses',async()=>{
 const publicFile=path.join(root,'public/products/current.jpg');await fs.copyFile(original,publicFile);
 const images=createProductImages(root),app=express();app.use('/product-images',images.middleware);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  let response=await fetch(base+productImage('/uploads/photo.heic.jpg',128));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');assert.match(response.headers.get('cache-control'),/max-age=31536000, immutable/);
  const etag=response.headers.get('etag');assert.ok(etag);await response.arrayBuffer();
  response=await fetch(base+productImage('/uploads/photo.heic.jpg',128),{cache:'no-cache',headers:{'If-None-Match':etag}});assert.equal(response.status,304);
  response=await fetch(base+productImage('/products/current.jpg',128));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'public, max-age=0');const before=response.headers.get('etag');await response.arrayBuffer();
  await sharp({create:{width:300,height:200,channels:3,background:'#0060ff'}}).jpeg().toFile(publicFile);
  response=await fetch(base+productImage('/products/current.jpg',128),{cache:'no-cache',headers:{'If-None-Match':before}});assert.equal(response.status,200);assert.notEqual(response.headers.get('etag'),before);await response.arrayBuffer();
  response=await fetch(base+'/product-images/v1/128?src='+encodeURIComponent('/uploads/../private.jpg'));assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'Photo non prise en charge.'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('very tall photos stay within a bounded output height without cropping',async()=>{
 const file=path.join(root,'uploads/tall.jpg');
 await sharp({create:{width:120,height:2000,channels:3,background:'#a0b0c0'}}).jpeg().toFile(file);
 const image=await createProductImages(root).prepare('/uploads/tall.jpg',800),metadata=await sharp(image.file).metadata();
 assert.equal(metadata.height,1600);assert.equal(metadata.width,96);assert.equal(metadata.width/metadata.height,120/2000);
});

test('presentation helpers keep original gallery identities and offer optional density-based responsive variants',()=>{
 const product={image:'/uploads/a.jpg',images:['/uploads/a.jpg','/uploads/b.webp']};
 assert.deepEqual(productPhotos(product),['/uploads/a.jpg','/uploads/b.webp']);
 assert.equal(productImage(product.image,128),'/product-images/v1/128?src=%2Fuploads%2Fa.jpg');
 assert.equal(productImageSet(product.image),'/product-images/v1/800?src=%2Fuploads%2Fa.jpg 1x, /product-images/v1/1600?src=%2Fuploads%2Fa.jpg 2x');
 assert.equal(productImage('blob:local',128),'blob:local');assert.equal(productImageSet('blob:local'),'');
 assert.equal(productImage('/uploads/../a.jpg',128),'/uploads/../a.jpg');
});
