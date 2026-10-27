import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
if(!process.env.CAMERA_FIXTURE)throw Error('Set CAMERA_FIXTURE to a Y4M video with a face.');
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3192',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')))});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-video-capture=${process.env.CAMERA_FIXTURE}`,'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({permissions:['camera']});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let failTracker=true,slowModel=true,modelRequests=0;
 await page.route('**/models/face_landmarker.task',route=>failTracker?route.fulfill({status:404,body:'missing'}):route.continue());
 await page.route('**/uploads/*.glb',async route=>{
  modelRequests++;if(slowModel)await new Promise(resolve=>setTimeout(resolve,1500));await route.continue().catch(()=>{});
 });
 await page.goto('http://127.0.0.1:3192');
 const products=await page.evaluate(()=>fetch('/api/products').then(r=>r.json()));const product=products.find(p=>p.id===(process.env.TRYON_PRODUCT_ID||'head-12028-col400'));
 assert.ok(product?.model,'A GLB-backed test product is required');
 async function open(){await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();await page.locator('#model-select').selectOption(product.id);}
 await open();await page.locator('#start-camera').click();
 await page.waitForFunction(()=>document.querySelector('#try-status').textContent.includes('HTTP 404'));
 assert.equal(await page.locator('#start-camera').textContent(),'Réessayer');
 assert.ok(await page.locator('#start-camera').isEnabled());
 assert.ok(await page.locator('#video').evaluate(v=>v.srcObject===null));
 failTracker=false;
 await page.locator('#start-camera').click();
 await page.waitForFunction(()=>document.querySelector('#try-status').textContent==='Chargement de la monture…',{},{timeout:60000});
 assert.ok(await page.locator('#camera-message').evaluate(el=>el.hidden),'Stale activation overlay is hidden while the GLB downloads');
 assert.equal(await page.locator('#snapshot').isEnabled(),false);
 await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
 await page.locator('#close-try').click();await page.waitForFunction(()=>document.querySelector('#video').srcObject===null);
 // Close while the next model request is pending, then open/retry immediately.
 await open();await page.locator('#start-camera').click();
 await page.waitForFunction(()=>document.querySelector('#try-status').textContent==='Chargement de la monture…');
 await page.locator('#close-try').click();await page.waitForFunction(()=>document.querySelector('#video').srcObject===null);
 slowModel=false;await open();await page.locator('#start-camera').click();
 await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
 assert.ok(await page.locator('#snapshot').isEnabled());assert.ok(modelRequests>=2);
 assert.deepEqual(errors,[]);
 console.log('PASS: missing tracker gives HTTP error, retry recovers, slow GLB shows loading, closing cancels, reopening recovers.');
}finally{await browser?.close();child.kill();}
