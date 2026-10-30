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
    navigator.mediaDevices.getUserMedia=(...args)=>{
      window.cameraRequests=(window.cameraRequests||0)+1;window.cameraConstraints=args[0];
      return get(...args).then(stream=>{
        // Simulate an exposed hardware zoom range without another camera
        // request, verifying that the widest setting is actually requested.
        const track=stream.getVideoTracks()[0],capabilities=track.getCapabilities.bind(track),apply=track.applyConstraints.bind(track);
        track.getCapabilities=()=>({...capabilities(),zoom:{min:1,max:4,step:.1}});
        track.applyConstraints=constraints=>{
          window.zoomConstraint=constraints;
          if(window.rejectZoom)return Promise.reject(new DOMException('Zoom unavailable','OverconstrainedError'));
          return apply(constraints);
        };
        return stream;
      });
    };
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
  const constraints=await page.evaluate(()=>({camera:window.cameraConstraints.video,zoom:window.zoomConstraint}));
  assert.equal(constraints.camera.resizeMode.ideal,'none');assert.equal(constraints.camera.aspectRatio,undefined,'do not force a sensor crop to the phone aspect ratio');
  assert.equal(constraints.zoom.advanced[0].zoom,1,'request the minimum supported hardware zoom');
  const resize=constraints.zoom.resizeMode;
  assert.equal(typeof resize==='string'?resize:resize?.ideal,'none','setting hardware zoom must preserve the uncropped stream constraint');
  assert.ok(await page.locator('#start-camera').isHidden(),'activation button is absent in the automatic flow');
  async function checkViewport(){
    const result=await page.evaluate(()=>{
      const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
      const backdrop=document.querySelector('#camera-backdrop'),style=getComputedStyle(backdrop);
      const pixels=backdrop.getContext('2d').getImageData(0,0,backdrop.width,backdrop.height).data;
      let coloured=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>30)coloured++;
      return {dialog:rect('dialog'),stage:rect('#camera-stage'),video:rect('#video'),canvas:rect('#overlay'),
        backdrop:{...rect('#camera-backdrop'),width:backdrop.width,height:backdrop.height,display:style.display,fit:style.objectFit,filter:style.filter,coloured},
        width:innerWidth,height:innerHeight,fit:getComputedStyle(document.querySelector('#overlay')).objectFit,
        locked:document.body.classList.contains('try-open')};
    });
    for(const r of [result.dialog,result.stage,result.video,result.canvas]){
      assert.ok(Math.abs(r.x)<1&&Math.abs(r.y)<1&&Math.abs(r.w-result.width)<2&&Math.abs(r.h-result.height)<2,'camera and AR canvas must cover the same viewport');
    }
    assert.equal(result.fit,'contain');assert.ok(result.locked);
    const b=result.backdrop;
    assert.equal(b.display,'block');assert.equal(b.fit,'cover');assert.match(b.filter,/blur\(24px\)/);
    assert.ok(b.x<=0&&b.y<=0&&b.w>=result.width&&b.h>=result.height,'blurred camera surround fills the viewport');
    assert.ok(Math.max(b.width,b.height)<=320&&Math.min(b.width,b.height)>1,'surround uses a small camera copy');
    assert.ok(b.coloured>b.width*b.height*.1,'surround contains actual camera pixels');
    assert.equal(await page.locator('#video').evaluate(v=>getComputedStyle(v).objectFit),'contain','video and AR use the same complete-frame view');
  }
  await checkViewport();
  await page.screenshot({path:'/tmp/tryit-mobile-camera-portrait.png'});
  const downloadPromise=page.waitForEvent('download');await page.locator('#snapshot').click();
  const download=await downloadPromise;await download.saveAs('/tmp/tryit-mobile-snapshot.png');
  const png=await fs.readFile('/tmp/tryit-mobile-snapshot.png');
  const nativeAspect=await page.locator('#video').evaluate(v=>v.videoWidth/v.videoHeight);
  assert.ok(Math.abs(png.readUInt32BE(16)/png.readUInt32BE(20)-nativeAspect)<.005,'download keeps the complete native camera frame');
  const alternative=await page.locator('#model-select').evaluate(select=>[...select.options].find(o=>o.value!==select.value)?.value);
  if(alternative){
    await page.locator(`.model-choice[data-model-id="${alternative}"]`).click();
    assert.equal(await page.locator(`.model-choice[data-model-id="${alternative}"]`).getAttribute('aria-pressed'),'true');
    await page.waitForFunction(()=>!document.querySelector('#snapshot').disabled&&document.querySelector('#try-status').textContent.startsWith('Visage détecté'),{},{timeout:60000});
    assert.equal(await page.evaluate(()=>window.cameraRequests),1,'changing glasses reuses the camera');
  }
  await page.setViewportSize({width:844,height:390});await checkViewport();
  assert.equal(await page.evaluate(()=>window.cameraRequests),1,'rotation must not request camera permission again');
  await page.screenshot({path:'/tmp/tryit-mobile-camera-landscape.png'});
  await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#video').srcObject&&!document.body.classList.contains('try-open'));
  assert.deepEqual(await page.locator('#camera-backdrop').evaluate(c=>[c.width,c.height]),[1,1],'closing releases the backdrop image');
  await page.evaluate(()=>{window.rejectZoom=true;});
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
  console.log('PASS: mobile one-tap camera, uncropped view with live blurred surround, minimum supported zoom, aligned AR, native-aspect snapshot, rotation, close/reopen, permission retry and late stream cleanup.');
} finally {await browser?.close();child.kill();}
