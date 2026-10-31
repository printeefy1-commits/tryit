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
const page=await browser.newPage({permissions:['camera'],acceptDownloads:true,...(process.env.MOBILE_CAMERA?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{})});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text()!=='INFO: Created TensorFlow Lite XNNPACK delegate for CPU.'){errors.push(m.text());console.error(m.text())}});
await page.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{window.testCameraRequests=(window.testCameraRequests||0)+1;return original(...args);};});
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
}
if(process.env.TRACKING_DROPOUTS||process.env.FRAME_SYNC){
  // Only the test response is instrumented; no production tracking hooks.
  await page.route('**/vendor/vision/vision_bundle.mjs',async route=>{
    const response=await route.fetch(),source=await response.text();
    const name=source.match(/(\w+) as FaceLandmarker\b/)[1];
    await route.fulfill({response,body:source+`\nconst realDetect=${name}.prototype.detectForVideo;
      ${name}.prototype.detectForVideo=function(...args){
      globalThis.testRawCameraFrame=args[0].toDataURL();
      globalThis.testSourcePixel=Array.from(args[0].getContext('2d').getImageData(0,0,1,1).data);
      if(globalThis.testSlowInference){const end=performance.now()+80;while(performance.now()<end){}}
      const result=realDetect.apply(this,args);
      return globalThis.testHideLandmarks?{faceLandmarks:[],facialTransformationMatrixes:[]}:result;};`});
  });
}
if(process.env.FRAME_SYNC||process.env.TRACKING_DROPOUTS){
  await page.route('**/tryon.js',async route=>{
    const response=await route.fetch(),source=await response.text();
    let body=source;
    if(process.env.TRACKING_DROPOUTS)body=body.replace('renderer.render(scene, camera)',`(()=>{
      const visibility=scene.children.map(child=>child.visible);
      scene.children.forEach(child=>{child.visible=false;});renderer.render(scene,camera);
      globalThis.testRenderedCameraFrame=canvas.toDataURL();
      scene.children.forEach((child,i)=>{child.visible=visibility[i];});
      renderer.render(scene, camera);
    })()`);
    if(process.env.FRAME_SYNC)body=body.replace('renderer.render(scene, camera)',
      '(renderer.render(scene, camera),globalThis.testSyncRecord(renderer))');
    if(process.env.FRAME_SYNC&&process.env.MOBILE_CAMERA)body=body.replace('backdropContext.drawImage(source,0,0,w,h);',
      `backdropContext.drawImage(source,0,0,w,h);
       if(globalThis.testSourcePixel)globalThis.testBackdropSamples.push({expected:globalThis.testSourcePixel,
         actual:Array.from(backdropContext.getImageData(0,0,1,1).data)});`);
    await route.fulfill({response,body});
  });
}
await page.goto('http://127.0.0.1:3189');
if(process.env.FRAME_SYNC){
  await page.evaluate(()=>{
    globalThis.testSyncSamples=[];globalThis.testBackdropSamples=[];globalThis.testSlowInference=true;
    globalThis.testSyncRecord=renderer=>{
      const pixel=new Uint8Array(4),gl=renderer.getContext();
      gl.readPixels(0,renderer.domElement.height-1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      globalThis.testSyncSamples.push({expected:globalThis.testSourcePixel,actual:Array.from(pixel)});
    };
  });
}
await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();
if(process.env.TRYON_PRODUCT_ID)await page.locator('#model-select').selectOption(process.env.TRYON_PRODUCT_ID,{force:true});

try{await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000})}catch(e){throw Error('Camera status: '+await page.locator('#try-status').textContent(),{cause:e})}
assert.equal(await page.locator('#snapshot').isEnabled(),true);
assert.equal(await page.evaluate(()=>window.testCameraRequests),1,'opening try-on starts the camera once without another activation button');
assert.ok(await page.locator('#start-camera').isHidden());
if(process.env.MODEL_SWITCH){
  const alternative=await page.locator('#model-select').evaluate(select=>[...select.options].find(o=>o.value!==select.value)?.value);
  assert.ok(alternative,'model switching requires two real GLB products');
  await page.locator(`.model-choice[data-model-id="${alternative}"]`).click();
  await page.waitForFunction(()=>!document.querySelector('#snapshot').disabled&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
  assert.equal(await page.locator('#model-select').inputValue(),alternative);
  assert.equal(await page.locator(`.model-choice[data-model-id="${alternative}"]`).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>window.testCameraRequests),1,'thumbnail switching reuses the active camera');
}
const downloadPromise=page.waitForEvent('download');await page.locator('#snapshot').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'mon-essayage.png');await download.saveAs(process.env.CAMERA_SNAPSHOT||'/tmp/atelier-camera-snapshot.png');
await page.screenshot({path:'/tmp/atelier-camera-ui.png'});
if(process.env.TRACKING_DROPOUTS){
  const glassesPixels=async()=>{
    const source=document.querySelector('#overlay'),image=new Image(),raw=new Image();
    image.src=source.toDataURL();raw.src=globalThis.testRenderedCameraFrame;await Promise.all([image.decode(),raw.decode()]);
    const c=document.createElement('canvas');c.width=source.width;c.height=source.height;
    const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;
    ctx.drawImage(raw,0,0,c.width,c.height);const r=ctx.getImageData(0,0,c.width,c.height).data;
    let n=0;for(let i=0;i<p.length;i+=4)if(Math.max(Math.abs(p[i]-r[i]),Math.abs(p[i+1]-r[i+1]),Math.abs(p[i+2]-r[i+2]))>25)n++;
    return n;
  };
  await page.evaluate(()=>{globalThis.testPoseClock=1000;});
  await page.waitForFunction(()=>globalThis.testPoseClockUsed===1000&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'));
  const previousBackdrop=await page.evaluate(()=>{
    globalThis.testHideLandmarks=true;globalThis.testPoseClock=1100;
    return document.querySelector('#camera-backdrop').toDataURL();
  });
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent==='Suivi momentanément incertain…');
  assert.ok(await page.evaluate(glassesPixels)>100,'brief loss retains the complete camera/glasses image');
  assert.equal(await page.locator('#snapshot').isEnabled(),false,'uncertain poses cannot be photographed');
  if(process.env.MOBILE_CAMERA)assert.equal(await page.locator('#camera-backdrop').evaluate(c=>c.toDataURL()),previousBackdrop,'brief loss retains the matching blurred surround');
  await page.evaluate(()=>{globalThis.testPoseClock=1500;});
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage insuffisamment visible'));
  assert.ok(await page.evaluate(glassesPixels)<10,'sustained loss leaves only the camera image');
  await page.evaluate(()=>{globalThis.testHideLandmarks=false;globalThis.testPoseClock=2000;});
  await page.waitForFunction(()=>document.querySelector('#try-status').textContent.startsWith('Visage détecté'));
  assert.ok(await page.locator('#snapshot').isEnabled());
  console.log('PASS: brief tracker loss retains glasses, sustained loss hides them with guidance, tracking recovers.');
}
if(process.env.FRAME_SYNC){
  await page.waitForFunction(()=>globalThis.testSyncSamples.length>=8);
  const samples=await page.evaluate(()=>globalThis.testSyncSamples);
  assert.ok(new Set(samples.map(s=>s.expected.slice(0,3).join(','))).size>=2,'Use a fixture with a changing corner colour marker');
  for(const {expected,actual} of samples)for(let i=0;i<4;i++)
    assert.ok(Math.abs(expected[i]-actual[i])<=4,'background must match the exact inference input even with 80-ms inference delay');
  if(process.env.MOBILE_CAMERA){
    const backdropSamples=await page.evaluate(()=>globalThis.testBackdropSamples);
    assert.ok(backdropSamples.length>=8);
    for(const {expected,actual} of backdropSamples)for(let i=0;i<4;i++)
      assert.ok(Math.abs(expected[i]-actual[i])<=4,'blurred surround must use the same frozen inference frame');
  }
  console.log('PASS: changing camera frames and glasses render together from the exact frozen inference input.');
}
await page.getByRole('button',{name:'Fermer'}).click();await page.waitForFunction(()=>document.querySelector('#video').srcObject===null);
assert.deepEqual(errors,[]);console.log('PASS: official face model loads, test face detected from simulated camera, snapshot downloads, camera stream stops on close.');
}finally{await browser?.close();child.kill()}
