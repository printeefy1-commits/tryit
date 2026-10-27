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
const page=await browser.newPage({permissions:['camera'],acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text()!=='INFO: Created TensorFlow Lite XNNPACK delegate for CPU.'){errors.push(m.text());console.error(m.text())}});
if(process.env.TRACKING_DROPOUTS){
  // A controlled clock keeps this test deterministic even when software WebGL
  // takes longer than the 220-ms grace period to render one frame.
  await page.route('**/tryon-fit.js',async route=>{
    const response=await route.fetch(),source=await response.text();
    await route.fulfill({response,body:source+`\nconst realPoseUpdate=PoseContinuity.prototype.update;
      PoseContinuity.prototype.update=function(fit,now){
        const clock=globalThis.testPoseClock??now;
        const result=realPoseUpdate.call(this,fit,clock);
        globalThis.testPoseClockUsed=clock;return result;};`});
  });
  // Only the test response is instrumented; no production tracking hooks.
  await page.route('**/vendor/vision/vision_bundle.mjs',async route=>{
    const response=await route.fetch(),source=await response.text();
    const name=source.match(/(\w+) as FaceLandmarker\b/)[1];
    await route.fulfill({response,body:source+`\nconst realDetect=${name}.prototype.detectForVideo;
      ${name}.prototype.detectForVideo=function(...args){const result=realDetect.apply(this,args);
      return globalThis.testHideLandmarks?{faceLandmarks:[],facialTransformationMatrixes:[]}:result;};`});
  });
}
await page.goto('http://127.0.0.1:3189');
await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
if(process.env.TRYON_PRODUCT_ID)await page.locator('#model-select').selectOption(process.env.TRYON_PRODUCT_ID);
await page.getByRole('button',{name:'Activer la caméra'}).click();
try{await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000})}catch(e){throw Error('Camera status: '+await page.locator('#try-status').textContent(),{cause:e})}
assert.equal(await page.locator('#snapshot').isEnabled(),true);
const downloadPromise=page.waitForEvent('download');await page.locator('#snapshot').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'mon-essayage.png');await download.saveAs(process.env.CAMERA_SNAPSHOT||'/tmp/atelier-camera-snapshot.png');
await page.screenshot({path:'/tmp/atelier-camera-ui.png'});
if(process.env.TRACKING_DROPOUTS){
  const alphaPixels=()=>{
    const source=document.querySelector('#overlay'),image=new Image();
    return new Promise(resolve=>{image.onload=()=>{const c=document.createElement('canvas');c.width=source.width;c.height=source.height;
      const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<p.length;i+=4)if(p[i])n++;resolve(n);};image.src=source.toDataURL();});
  };
  await page.evaluate(()=>{globalThis.testPoseClock=1000;});
  await page.waitForFunction(()=>globalThis.testPoseClockUsed===1000&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'));
  await page.evaluate(()=>{globalThis.testHideLandmarks=true;globalThis.testPoseClock=1100;});
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent==='Suivi momentanément incertain…');
  assert.ok(await page.evaluate(alphaPixels)>100,'brief loss retains the actual rendered glasses');
  assert.equal(await page.locator('#snapshot').isEnabled(),false,'uncertain poses cannot be photographed');
  await page.evaluate(()=>{globalThis.testPoseClock=1500;});
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage insuffisamment visible'));
  assert.equal(await page.evaluate(alphaPixels),0,'sustained loss clears the stale overlay');
  await page.evaluate(()=>{globalThis.testHideLandmarks=false;globalThis.testPoseClock=2000;});
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'));
  assert.ok(await page.locator('#snapshot').isEnabled());
  console.log('PASS: brief tracker loss retains glasses, sustained loss hides them with guidance, tracking recovers.');
}
await page.getByRole('button',{name:'Fermer'}).click();await page.waitForFunction(()=>document.querySelector('#video').srcObject===null);
assert.deepEqual(errors,[]);console.log('PASS: official face model loads, test face detected from simulated camera, snapshot downloads, camera stream stops on close.');
}finally{await browser?.close();child.kill()}
