import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

if(!process.env.CAMERA_FIXTURE)throw Error('Set CAMERA_FIXTURE to a Y4M test face.');
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3201',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'});
let browser;
try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:[
    '--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${process.env.CAMERA_FIXTURE}`,'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const options={viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2};
  const context=await browser.newContext({...options,permissions:['camera'],acceptDownloads:true});
  await context.addInitScript(()=>{
    const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=(...args)=>{window.cameraRequests=(window.cameraRequests||0)+1;return get(...args);};
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3201');
  let productIndex=0;
  if(process.env.TRYON_PRODUCT_ID){
    const products=await page.evaluate(()=>fetch('/api/products').then(r=>r.json()));
    productIndex=products.findIndex(p=>p.id===process.env.TRYON_PRODUCT_ID);assert.ok(productIndex>=0);
  }
  await page.locator('.product').nth(productIndex).getByRole('button').click();
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.cameraRequests),1,'one tap requests the camera once');
  assert.ok(await page.locator('#start-camera').isHidden(),'activation button is absent in the automatic flow');
  async function checkViewport(){
    const result=await page.evaluate(()=>{
      const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
      return {dialog:rect('dialog'),stage:rect('#camera-stage'),video:rect('#video'),canvas:rect('#overlay'),
        width:innerWidth,height:innerHeight,fit:getComputedStyle(document.querySelector('#overlay')).objectFit,
        locked:document.body.classList.contains('try-open')};
    });
    for(const r of [result.dialog,result.stage,result.video,result.canvas]){
      assert.ok(Math.abs(r.x)<1&&Math.abs(r.y)<1&&Math.abs(r.w-result.width)<2&&Math.abs(r.h-result.height)<2,'camera and AR canvas must cover the same viewport');
    }
    assert.equal(result.fit,'cover');assert.ok(result.locked);
  }
  await checkViewport();
  await page.screenshot({path:'/tmp/tryit-mobile-camera-portrait.png'});
  const downloadPromise=page.waitForEvent('download');await page.locator('#snapshot').click();
  const download=await downloadPromise;await download.saveAs('/tmp/tryit-mobile-snapshot.png');
  const png=await fs.readFile('/tmp/tryit-mobile-snapshot.png');
  assert.ok(Math.abs(png.readUInt32BE(16)/png.readUInt32BE(20)-390/844)<.005,'download matches the visible portrait crop');
  const alternative=await page.locator('#model-select').evaluate(select=>[...select.options].find(o=>o.value!==select.value)?.value);
  if(alternative){
    await page.locator('#model-select').selectOption(alternative);
    await page.waitForFunction(()=>!document.querySelector('#snapshot').disabled&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
    assert.equal(await page.evaluate(()=>window.cameraRequests),1,'changing glasses reuses the camera');
  }
  await page.setViewportSize({width:844,height:390});await checkViewport();
  assert.equal(await page.evaluate(()=>window.cameraRequests),1,'rotation must not request camera permission again');
  await page.screenshot({path:'/tmp/tryit-mobile-camera-landscape.png'});
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#video').srcObject&&!document.body.classList.contains('try-open'));
  await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
  await page.waitForFunction(()=>window.cameraRequests===2&&document.querySelector('#video').srcObject);
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await context.close();assert.deepEqual(errors,[]);

  const denied=await browser.newContext(options);
  await denied.addInitScript(()=>{navigator.mediaDevices.getUserMedia=()=>{
    window.cameraRequests=(window.cameraRequests||0)+1;return Promise.reject(new DOMException('Denied','NotAllowedError'));
  };});
  const deniedPage=await denied.newPage();await deniedPage.goto('http://127.0.0.1:3201');
  await deniedPage.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
  await deniedPage.getByRole('button',{name:'Réessayer',exact:true}).waitFor();
  assert.equal(await deniedPage.evaluate(()=>window.cameraRequests),1);
  await deniedPage.getByRole('button',{name:'Réessayer',exact:true}).click();
  await deniedPage.waitForFunction(()=>window.cameraRequests===2);
  await denied.close();

  const late=await browser.newContext(options);
  await late.addInitScript(()=>{
    window.pendingCameras=[];window.stoppedCameras=0;
    navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.pendingCameras.push(()=>resolve({getTracks:()=>[{stop(){window.stoppedCameras++;}}]})));
  });
  const latePage=await late.newPage();await latePage.goto('http://127.0.0.1:3201');
  await latePage.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
  await latePage.getByRole('button',{name:'Fermer',exact:true}).click();
  await latePage.waitForFunction(()=>!document.body.classList.contains('try-open'));
  await latePage.evaluate(()=>window.pendingCameras[0]());
  await latePage.waitForFunction(()=>window.stoppedCameras===1);
  assert.equal(await latePage.evaluate(()=>document.querySelector('#video').srcObject),null);
  await late.close();
  console.log('PASS: mobile one-tap camera, viewport coverage, aligned AR crop, portrait snapshot, rotation, close/reopen, permission retry and late stream cleanup.');
} finally {await browser?.close();child.kill();}
