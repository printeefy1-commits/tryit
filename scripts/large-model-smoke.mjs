import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
if(!process.env.LARGE_GLB_FIXTURE)throw Error('Set LARGE_GLB_FIXTURE to the actual dense GLB.');
const password=crypto.randomBytes(20).toString('hex'),child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3207',ADMIN_PASSWORD:password},stdio:'pipe'});
let browser;
try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3207/admin.html');await page.locator('#password').fill(password);await page.getByRole('button',{name:'Se connecter',exact:true}).click();await page.locator('#dashboard').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Ajouter une monture'}).click();
  await page.locator('[name=model]').setInputFiles(process.env.LARGE_GLB_FIXTURE);
  await page.waitForFunction(()=>document.querySelector('#preview-status').textContent.startsWith('Modèle prêt'),{},{timeout:240000});
  assert.ok(await page.locator('#save-product').isEnabled());assert.equal(await page.getByText('Maximum call stack size exceeded',{exact:true}).count(),0);
  await page.locator('.model-viewer').screenshot({path:'/tmp/tryit-large-model-preview.png'});
  await page.getByRole('button',{name:'Annuler',exact:true}).click();assert.deepEqual(errors,[]);
  console.log('PASS: actual dense GLB parses, prepares and renders in the admin preview without call-stack overflow; saving is enabled. No product was created.');
}finally{await browser?.close();child.kill();}
