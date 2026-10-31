import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import express from 'express';
import {createStaticAssets} from '../static-assets.js';

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tryit-static-'));
 for(const dir of ['public/models','public/assets','node_modules/three/build','node_modules/@mediapipe/tasks-vision/wasm'])await fs.mkdir(path.join(root,dir),{recursive:true});
 const bytes=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.alloc(1024*1024,37)]);
 const app='export const marker="original";\n'.repeat(150);
 const map='{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}';
 const html=`<!doctype html><link rel="stylesheet" href="/style.css"><script type="importmap">${map}</script><script type="module" src="/app.js"></script><a href="/admin.html">Admin</a><img src="/assets/logo.png">`;
 await Promise.all([
  fs.writeFile(path.join(root,'public/models/test.wasm'),bytes),fs.writeFile(path.join(root,'public/app.js'),app),
  fs.writeFile(path.join(root,'public/style.css'),"@font-face{src:url('/assets/logo.png')}body{color:black}\n".repeat(100)),
  fs.writeFile(path.join(root,'public/assets/logo.png'),randomBytes(64)),
  fs.writeFile(path.join(root,'public/index.html'),html),fs.writeFile(path.join(root,'public/admin.html'),html),
  fs.writeFile(path.join(root,'node_modules/three/build/three.module.js'),app),
  fs.writeFile(path.join(root,'node_modules/@mediapipe/tasks-vision/wasm/engine.wasm'),bytes)
 ]);
 return {root,bytes,app};
}
async function serve(assets){
 const app=express();app.use(assets.htmlMiddleware);app.use(assets.middleware);app.get('/api/products',(req,res)=>res.set('Cache-Control','no-store').json([]));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 return {base:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('WASM is transported losslessly with Brotli/gzip, decoded lengths, conditional responses and identity ranges',async()=>{
 const {root,bytes}=await fixture(),assets=await createStaticAssets({root}),site=await serve(assets);
 try{
  for(const encoding of ['br','gzip','identity']){
   const response=await fetch(site.base+assets.url('/models/test.wasm'),{headers:{'Accept-Encoding':encoding}});
   assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/wasm');
   assert.match(response.headers.get('cache-control'),/max-age=31536000, immutable/);
   assert.equal(Number(response.headers.get('x-model-bytes')),bytes.length);assert.equal(Number(response.headers.get('x-asset-bytes')),bytes.length);
   assert.equal(response.headers.get('content-encoding'),encoding==='identity'?null:encoding);
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes,'browser decoding returns the exact original WASM');
   if(encoding!=='identity')assert.ok(Number(response.headers.get('content-length'))<bytes.length/2);
   const cached=await fetch(site.base+assets.url('/models/test.wasm'),{headers:{'Accept-Encoding':encoding,'If-None-Match':response.headers.get('etag'),'Cache-Control':'max-age=0'}});
   assert.equal(cached.status,304);assert.equal((await cached.arrayBuffer()).byteLength,0);
   const head=await fetch(site.base+assets.url('/models/test.wasm'),{method:'HEAD',headers:{'Accept-Encoding':encoding}});
   assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),response.headers.get('content-length'));assert.equal((await head.arrayBuffer()).byteLength,0);
  }
  const range=await fetch(site.base+assets.url('/models/test.wasm'),{headers:{Range:'bytes=100-109','Accept-Encoding':'gzip'}});
  assert.equal(range.status,206);assert.equal(range.headers.get('content-encoding'),null);assert.equal(range.headers.get('content-range'),`bytes 100-109/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(100,110));
  const rejected=await fetch(site.base+assets.url('/models/test.wasm'),{headers:{'Accept-Encoding':'br;q=0,gzip;q=0,identity;q=0'}});assert.equal(rejected.status,406);
  const legacy=await fetch(site.base+'/models/test.wasm',{headers:{'Accept-Encoding':'gzip'}});assert.match(legacy.headers.get('cache-control'),/max-age=0/);assert.equal(legacy.headers.get('content-encoding'),'gzip');assert.deepEqual(Buffer.from(await legacy.arrayBuffer()),bytes);
  const api=await fetch(site.base+'/api/products');assert.equal(api.headers.get('cache-control'),'no-store');assert.deepEqual(await api.json(),[]);
 }finally{await site.close();await fs.rm(root,{recursive:true,force:true});}
});

test('HTML/importmap share a valid CSP hash and immutable snapshots change with source content',async()=>{
 const {root,app:original}=await fixture(),first=await createStaticAssets({root}),site=await serve(first);
 let secondSite;
 try{
  const response=await fetch(site.base+'/'),html=await response.text();assert.equal(response.headers.get('cache-control'),'no-store');
  assert.ok(html.includes(`src="${first.prefix}/app.js"`));assert.ok(html.includes(`href="${first.prefix}/style.css"`));assert.ok(html.includes(`src="${first.prefix}/assets/logo.png"`));
  assert.ok(html.includes('href="/admin.html"'),'navigation URLs are not treated as static assets');
  const css=await(await fetch(site.base+first.url('/style.css'))).text();assert.ok(css.includes("url('"+first.prefix+"/assets/logo.png')"),'CSS font/image URLs agree with HTML preloads');
  const importMap=html.match(/<script type="importmap">(.*?)<\/script>/)[1];assert.equal(importMap,first.importMap);
  assert.equal(first.importMapHash,"'sha256-"+createHash('sha256').update(importMap).digest('base64')+"'");
  const same=await createStaticAssets({root});assert.equal(same.build,first.build,'restart without source changes reuses immutable URLs');
  await fs.writeFile(path.join(root,'public/app.js'),'export const marker="updated";');
  const second=await createStaticAssets({root});assert.notEqual(second.build,first.build);
  const old=await fetch(site.base+first.url('/app.js'));assert.equal(await old.text(),original,'an old process continues serving the matching snapshot during deployment');
  secondSite=await serve(second);
  const stale=await fetch(secondSite.base+first.url('/app.js'));assert.equal(stale.status,404);assert.equal(stale.headers.get('cache-control'),'no-store');
  const fresh=await fetch(secondSite.base+second.url('/app.js'));assert.equal(await fresh.text(),'export const marker="updated";');
  const traversal=await fetch(secondSite.base+second.prefix+'/%2e%2e%2fpackage.json');assert.equal(traversal.status,404);
  const admin=await fetch(secondSite.base+'/admin.html');assert.equal(admin.headers.get('cache-control'),'no-store');
 }finally{await secondSite?.close();await site.close();await fs.rm(root,{recursive:true,force:true});}
});
