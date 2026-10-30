import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {uploadModelFixture} from '../scripts/upload-model-fixture.mjs';
let child,cookie;const base='http://127.0.0.1:3187',password=crypto.randomBytes(20).toString('hex');
before(async()=>{child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3187',ADMIN_PASSWORD:password},stdio:'pipe'});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));setTimeout(()=>reject(Error('Startup timeout')),8000).unref()})});
after(()=>child?.kill());
test('public catalogue, protected writes, login, upload, visibility, edit and delete',async()=>{
 assert.equal((await fetch(base)).status,200);
 let r=await fetch(base+'/api/products');const catalogue=await r.json();assert.ok(Array.isArray(catalogue));assert.ok(!catalogue.some(p=>p.id==='demo'&&p.demo),'retired demo is absent from the catalogue');
 assert.equal((await fetch(base+'/api/admin/products')).status,401);
 assert.equal((await fetch(base+'/api/admin/products/new',{method:'POST'})).status,401);
 assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})})).status,401);
 r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(base+'/api/admin/products',{headers:{cookie}})).status,200);
 assert.equal((await fetch(base+'/api/admin/products/new',{method:'POST',headers:{cookie,origin:'https://attacker.invalid'}})).status,403);
 const data=new FormData();data.set('name','Test monture');data.set('brand','Test');data.set('visible','false');data.set('frameWidthMm','142.5');data.set('image',new Blob([Buffer.from('89504e470d0a1a0a00000000','hex')],{type:'image/png'}),'test.png');
 r=await fetch(base+'/api/admin/products/new',{method:'POST',headers:{cookie},body:data});assert.equal(r.status,200);const product=await r.json();assert.ok(product.image);
 assert.equal(product.frameWidthMm,142.5);
 assert.equal((await fetch(base+product.image)).status,200);
 assert.ok(!(await (await fetch(base+'/api/products')).json()).some(p=>p.id===product.id));
 const update=new FormData();update.set('name','Test modifié');update.set('brand','Test');update.set('visible','true');
 assert.equal((await fetch(base+'/api/admin/products/'+product.id,{method:'POST',headers:{cookie},body:update})).status,200);
 let saved=(await(await fetch(base+'/api/admin/products',{headers:{cookie}})).json()).find(p=>p.id===product.id);
 assert.equal(saved.frameWidthMm,142.5,'older editors preserve the optional measurement');
 update.set('frameWidthMm','NaN');assert.equal((await fetch(base+'/api/admin/products/'+product.id,{method:'POST',headers:{cookie},body:update})).status,400);
 update.set('frameWidthMm','11');assert.equal((await fetch(base+'/api/admin/products/'+product.id,{method:'POST',headers:{cookie},body:update})).status,400,'centimetres are not accepted as millimetres');
 update.set('frameWidthMm','');assert.equal((await fetch(base+'/api/admin/products/'+product.id,{method:'POST',headers:{cookie},body:update})).status,200);
 saved=(await(await fetch(base+'/api/admin/products',{headers:{cookie}})).json()).find(p=>p.id===product.id);assert.equal(saved.frameWidthMm,undefined,'clearing the measurement returns to estimated fit');
 assert.ok((await (await fetch(base+'/api/products')).json()).some(p=>p.id===product.id&&p.name==='Test modifié'));
 assert.equal((await fetch(base+'/api/admin/products/'+product.id,{method:'DELETE',headers:{cookie}})).status,200);
 const overlapping=Promise.all(Array.from({length:6},()=>fetch(base+'/api/admin/products',{headers:{cookie}})));
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{cookie}})).status,200);
 await overlapping;
 assert.equal((await fetch(base+'/api/admin/products',{headers:{cookie}})).status,401);
});

test('direct GLB uploads over 25 MiB publish immediately, preserve replacements and retry the same creation without duplicates',async()=>{
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
 const token=login.headers.get('set-cookie').split(';')[0],headers={cookie:token};
 const original=await fs.readFile(new URL('../public/products/models-v2/head-blue.glb',import.meta.url));
 const padded=uploadModelFixture(original),photo=await fs.readFile(new URL('../public/products/models-v2/product.webp',import.meta.url));
 const id=crypto.randomUUID();
 function fields(){const data=new FormData();for(const [key,value] of Object.entries({name:'Direct API upload',brand:'HEAD',visible:'true',scale:'0.95',offset:'0.03',frameWidthMm:'143',productId:id,imageFit:'contain',rotationX:'0',rotationY:'90',rotationZ:'0'}))data.set(key,value);return data;}
 try{
  const data=fields();data.set('model',new Blob([padded]),'large.glb');data.set('image',new Blob([photo]),'photo.webp');
  let response=await fetch(base+'/api/admin/products/new',{method:'POST',headers,body:data});assert.equal(response.status,200);
  const product=await response.json();assert.equal(product.id,id);assert.ok(product.modelBytes>25*1024*1024);assert.deepEqual(product.modelRotation,[0,90,0]);
  assert.equal(product.sourceSha256,crypto.createHash('sha256').update(padded).digest('hex'));assert.equal(product.frameWidthMm,143);
  response=await fetch(base+product.model);assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),padded.length);await response.body.cancel();
  assert.ok((await(await fetch(base+'/api/products')).json()).some(p=>p.id===id&&p.model===product.model));
  response=await fetch(base+'/api/admin/products/new',{method:'POST',headers,body:fields()});assert.equal(response.status,200);assert.equal((await response.json()).id,id);
  let catalogue=await(await fetch(base+'/api/admin/products',{headers})).json();assert.equal(catalogue.filter(p=>p.id===id).length,1);
  const replacement=fields();replacement.set('model',new Blob([original]),'replacement.glb');
  response=await fetch(base+'/api/admin/products/'+id,{method:'POST',headers,body:replacement});assert.equal(response.status,200);
  const updated=await response.json();assert.equal(updated.previousModel,product.model);assert.equal(updated.previousModelSourceSha256,product.sourceSha256);assert.equal(updated.image,product.image);
  assert.equal(updated.scale,.95);assert.equal(updated.offset,.03);assert.equal(updated.frameWidthMm,143);
  response=await fetch(base+product.model);assert.equal(response.status,200);await response.body.cancel();
 }finally{await fetch(base+'/api/admin/products/'+id,{method:'DELETE',headers});await fetch(base+'/api/logout',{method:'POST',headers});}
});

test('bad or external-resource GLB uploads fail without publishing files or changing the catalogue',async()=>{
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
 const headers={cookie:login.headers.get('set-cookie').split(';')[0]};
 const original=await fs.readFile(new URL('../public/products/models-v2/head-blue.glb',import.meta.url));
 const before=await(await fetch(base+'/api/admin/products',{headers})).json();
 const published=(await fs.readdir(new URL('../uploads/',import.meta.url))).sort();
 for(const [bytes,filename] of [
  [Buffer.from('not a model'),'bad.glb'],
  [uploadModelFixture(original,0,doc=>{doc.images=[{uri:'https://example.com/texture.png'}];}),'external.glb'],
  [uploadModelFixture(original,0,doc=>{doc.extensionsUsed=['KHR_texture_basisu'];}),'compressed.glb'],
  [original,'wrong.txt']
 ]){
  const data=new FormData();data.set('name','Invalid upload');data.set('brand','HEAD');data.set('model',new Blob([bytes]),filename);
  const response=await fetch(base+'/api/admin/products/new',{method:'POST',headers,body:data});assert.equal(response.status,400);assert.ok((await response.json()).error);
 }
 assert.deepEqual(await(await fetch(base+'/api/admin/products',{headers})).json(),before);
 assert.deepEqual((await fs.readdir(new URL('../uploads/',import.meta.url))).sort(),published);
 await fetch(base+'/api/logout',{method:'POST',headers});
});
