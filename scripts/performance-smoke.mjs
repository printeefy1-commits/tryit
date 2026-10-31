// Checks measurable loading budgets and the user gesture across a deferred engine.
// Uses repository fixtures in an isolated catalogue; never changes owner data.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';
if(!process.env.CAMERA_FIXTURE)throw Error('Set CAMERA_FIXTURE to a Y4M test face.');
const source=new URL('..',import.meta.url).pathname,root=await fs.mkdtemp('/tmp/tryit-perf-smoke-');
for(const file of await fs.readdir(source))if(file.endsWith('.js')||file==='package.json')await fs.copyFile(path.join(source,file),path.join(root,file));
for(const dir of ['node_modules','public','uploads'])await fs.symlink(path.join(source,dir),path.join(root,dir));
await fs.mkdir(path.join(root,'data'));await fs.copyFile(path.join(source,'data/catalog.json'),path.join(root,'data/catalog.json'));
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'3225',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Server failed '+code)));});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-video-capture=${process.env.CAMERA_FIXTURE}`]});
 const context=await browser.newContext({permissions:['camera'],viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 await context.addInitScript(()=>{
  window.requestsWithinTap=[];window.acquiredStreams=[];
  const request=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=(...args)=>{window.requestsWithinTap.push(navigator.userActivation.isActive);return request(...args).then(stream=>{window.acquiredStreams.push(stream);return stream;});};
 });
 const page=await context.newPage(),urls=[],errors=[];page.on('request',r=>urls.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3225',{waitUntil:'networkidle'});
 await page.locator('#hero-photo').evaluate(image=>image.decode());
 const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>({url:e.name,bytes:e.transferSize})));
 assert.ok(!urls.some(url=>/\/vendor\/|\.wasm|\.task|\.glb|\/tryon\.js/.test(url)),'storefront must not fetch the mirror engine or models');
 assert.ok(resources.reduce((n,r)=>n+r.bytes,0)<500000,'fixture storefront stays below a 500 KB cold-transfer budget');
 const fontRequests=urls.filter(url=>url.endsWith('/assets/fonts/manrope.woff'));assert.equal(fontRequests.length,1,'font preload and CSS share one versioned URL');
 assert.ok(fontRequests[0].includes('/assets-v/'));
 const imageUrls=await page.locator('.product-art>img').evaluateAll(images=>images.map(image=>image.currentSrc));assert.ok(imageUrls.every(url=>url.includes('/product-images/v1/')),'cards use appropriately sized variants');
 let release,requested;const gate=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{requested=resolve;});
 await page.route('**/tryon.js',async route=>{requested();await gate;await route.continue().catch(()=>{});});
 await page.getByRole('button',{name:'Essayer sur mon visage'}).nth(1).click();await seen;
 assert.deepEqual(await page.evaluate(()=>window.requestsWithinTap),[true],'first camera request happens in original tap before the 3D module loads');
 await page.getByRole('button',{name:'Fermer',exact:true}).click();
 await page.waitForFunction(()=>window.acquiredStreams.length===1&&window.acquiredStreams[0].getTracks().every(track=>track.readyState==='ended'));
 release();await page.waitForTimeout(800);
 assert.ok(!urls.some(url=>/\.task|\.wasm|\.glb/.test(url)),'closing during module download must not start a tracker or model download');
 await page.getByRole('button',{name:'Essayer sur mon visage'}).nth(1).click();
 await page.waitForFunction(()=>!document.querySelector('#snapshot').disabled&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:90000});
 assert.deepEqual(await page.evaluate(()=>window.requestsWithinTap),[true,true]);
 assert.ok(urls.some(url=>/\/assets-v\/[^/]+\/vendor\/vision\/wasm\/.*\.wasm/.test(url)),'tracking WASM uses the versioned compressed route');
 const diagnostics=await page.evaluate(()=>window.tryonDiagnostics());assert.ok(diagnostics.templeGroups>=2&&diagnostics.fitting.templeFit.adjustment==='hinge-rotation');
 await page.getByRole('button',{name:'Fermer',exact:true}).click();
 await page.waitForFunction(()=>window.acquiredStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({coldResourceBytes:resources.reduce((n,r)=>n+r.bytes,0),coldRequests:resources.length,fontRequests:fontRequests.length,cameraRequests:2}));
 console.log('PASS: lean storefront, responsive photos, single font fetch, camera permission in original tap, close during delayed import, versioned WASM, and unchanged temple controller.');
}finally{await browser?.close();child.kill();}
