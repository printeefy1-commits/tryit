import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {fetchBuffer,waitFor} from '../public/tryon-loading.js';
let server,base;
before(async()=>{
 server=http.createServer((req,res)=>{
  if(req.url==='/compressed'){const bytes=gzipSync('x'.repeat(4096));res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':String(bytes.length),'X-Model-Bytes':'4096'});res.end(bytes);return;}
  if(req.url==='/missing'){res.writeHead(404);res.end('missing');return;}
  if(req.url==='/hang')return;
  if(req.url==='/oversized'){res.writeHead(200,{'Content-Length':'99999999'});res.end();return;}
  if(req.url==='/slow'){
   res.writeHead(200,{'Content-Length':'5'});let sent=0;
   const timer=setInterval(()=>{res.write('x');if(++sent===5){clearInterval(timer);res.end();}},35);
   res.on('close',()=>clearInterval(timer));return;
  }
  res.writeHead(200,{'Content-Length':'6'});res.write('abc');setTimeout(()=>res.end('def'),10);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

test('asset transfer preserves bytes and reports completed progress',async()=>{
 const progress=[];const bytes=await fetchBuffer(base+'/ok',{onProgress:(got,total)=>progress.push([got,total])});
 assert.equal(new TextDecoder().decode(bytes),'abcdef');assert.deepEqual(progress.at(-1),[6,6]);
});
test('missing and oversized models fail with an actionable message',async()=>{
 await assert.rejects(fetchBuffer(base+'/missing',{label:'Modèle 3D'}),/Modèle 3D.*HTTP 404/);
 await assert.rejects(fetchBuffer(base+'/oversized'),/trop volumineux/);
});
test('a stalled connection times out, but a progressing slow transfer succeeds',async()=>{
 await assert.rejects(fetchBuffer(base+'/hang',{inactivityMs:100,label:'Modèle 3D'}),/ne répond plus/);
 assert.equal(new TextDecoder().decode(await fetchBuffer(base+'/slow',{inactivityMs:120})),'xxxxx');
});
test('closing the session cancels a pending transfer',async()=>{
 const controller=new AbortController();const request=fetchBuffer(base+'/hang',{signal:controller.signal});
 controller.abort();await assert.rejects(request,e=>e.name==='AbortError');
});
test('initializer timeout is bounded and a late result does not cause an unhandled failure',async()=>{
 await assert.rejects(waitFor(new Promise((resolve,reject)=>setTimeout(()=>reject(Error('late failure')),30)),10,'Initializer timed out'),/Initializer timed out/);
 await new Promise(resolve=>setTimeout(resolve,40));
});

test('compressed model downloads report decoded progress and enforce the decoded limit',async()=>{
 const progress=[],bytes=await fetchBuffer(base+'/compressed',{onProgress:(got,total)=>progress.push([got,total])});
 assert.equal(bytes.byteLength,4096);assert.deepEqual(progress.at(-1),[4096,4096]);
 await assert.rejects(fetchBuffer(base+'/compressed',{maxBytes:1024}),/trop volumineux/);
});
