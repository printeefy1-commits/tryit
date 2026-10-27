import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
if(!process.env.CAMERA_FIXTURE)throw Error('Set CAMERA_FIXTURE to a Y4M video containing a test face.');
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3189',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try{
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')))});
browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-video-capture=${process.env.CAMERA_FIXTURE}`,'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({permissions:['camera'],acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
await page.goto('http://127.0.0.1:3189');
await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
if(process.env.TRYON_PRODUCT_ID)await page.locator('#model-select').selectOption(process.env.TRYON_PRODUCT_ID);
await page.getByRole('button',{name:'Activer la caméra'}).click();
try{await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000})}catch(e){throw Error('Camera status: '+await page.locator('#try-status').textContent(),{cause:e})}
assert.equal(await page.locator('#snapshot').isEnabled(),true);
const downloadPromise=page.waitForEvent('download');await page.locator('#snapshot').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'mon-essayage.png');await download.saveAs(process.env.CAMERA_SNAPSHOT||'/tmp/atelier-camera-snapshot.png');
await page.screenshot({path:'/tmp/atelier-camera-ui.png'});
await page.getByRole('button',{name:'Fermer'}).click();await page.waitForFunction(()=>document.querySelector('#video').srcObject===null);
assert.deepEqual(errors,[]);console.log('PASS: official face model loads, test face detected from simulated camera, snapshot downloads, camera stream stops on close.');
}finally{await browser?.close();child.kill()}
