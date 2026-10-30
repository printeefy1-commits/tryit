// Starts production against an isolated catalogue. Never changes owner products.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const sourceRoot=new URL('..',import.meta.url).pathname,root=await fs.mkdtemp(path.join(os.tmpdir(),'tryit-production-optimization-'));
for(const file of await fs.readdir(sourceRoot))if(file.endsWith('.js')||file==='package.json')await fs.copyFile(path.join(sourceRoot,file),path.join(root,file));
await fs.mkdir(root+'/scripts');await fs.copyFile(sourceRoot+'/scripts/optimize-model-worker.mjs',root+'/scripts/optimize-model-worker.mjs');
await fs.symlink(sourceRoot+'/node_modules',root+'/node_modules');await fs.symlink(sourceRoot+'/public',root+'/public');
await fs.mkdir(root+'/data');await fs.mkdir(root+'/uploads');
const specifications=[['head-12028-col400','12029','products/head-12028/head-12028-generated.glb'],['head-12028-models-v2','12028','products/models-v2/head-blue.glb']];
const products=[],originals=new Map();
for(const [id,name,source] of specifications){
 const filename='migration-'+name+'.glb',bytes=await fs.readFile(sourceRoot+'/public/'+source);await fs.writeFile(root+'/uploads/'+filename,bytes);originals.set(id,bytes);
 const image='migration-'+name+'.webp';await fs.copyFile(sourceRoot+'/public/products/models-v2/product.webp',root+'/uploads/'+image);
 products.push({id,name,brand:'HEAD',visible:true,model:'/uploads/'+filename,image:'/uploads/'+image,scale:.98,offset:.02,modelRotation:[0,0,0],frameWidthMm:140});
}
await fs.writeFile(root+'/data/catalog.json',JSON.stringify(products));
const password=crypto.randomBytes(20).toString('hex'),base='http://127.0.0.1:3209';
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'3209',NODE_ENV:'production',AUTO_OPTIMIZE_EXISTING:'1',ADMIN_PASSWORD:password,SESSION_SECRET:crypto.randomBytes(32).toString('hex')},stdio:'pipe'});
let errors='';child.stderr.on('data',data=>errors+=data);
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed: '+errors)));});
 const deadline=Date.now()+90000;let saved;
 while(Date.now()<deadline){
  saved=await(await fetch(base+'/api/products',{signal:AbortSignal.timeout(1500)})).json();
  if(saved.every(p=>p.modelOptimization?.version===1))break;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(saved.every(p=>p.modelOptimization?.version===1),errors||'Production migration did not finish');
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https'},body:JSON.stringify({password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 for(const product of saved){
  const before=products.find(p=>p.id===product.id);assert.equal(product.modelOriginal,before.model);assert.ok(product.modelBytes<originals.get(product.id).length);
  for(const key of ['scale','offset','modelRotation','image','frameWidthMm'])assert.deepEqual(product[key],before[key]);
  assert.deepEqual(await fs.readFile(root+product.modelOriginal),originals.get(product.id));
  const response=await fetch(base+product.model,{headers:{'Accept-Encoding':'br'}});assert.equal(response.headers.get('content-encoding'),'br');assert.match(response.headers.get('cache-control'),/immutable/);await response.arrayBuffer();
  const again=await fetch(base+'/api/admin/products/'+product.id+'/optimize',{method:'POST',headers:{cookie,'X-Forwarded-Proto':'https'}});assert.equal(again.status,200);assert.equal((await again.json()).model,product.model);
 }
 console.log(JSON.stringify({root,products:saved.map(p=>({id:p.id,original:p.modelOriginalBytes,web:p.modelBytes,transfer:p.modelOptimization.transferBytes}))},null,2));
 console.log('PASS: production startup migrates existing models once without blocking HTTP, preserves original files and all product settings, and serves encoded immutable GLBs.');
}finally{child.kill();}
