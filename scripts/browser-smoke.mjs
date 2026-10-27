import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const password=crypto.randomBytes(20).toString('hex');
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3188',ADMIN_PASSWORD:password},stdio:'pipe'});
let browser;
try{
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')))});
browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:3188');await page.getByRole('button',{name:'Essayer sur mon visage'}).first().click();await page.locator('dialog').waitFor({state:'visible'});await page.getByRole('button',{name:'Fermer'}).click();
await page.screenshot({path:'/tmp/atelier-desktop.png',fullPage:true});
await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/atelier-mobile.png',fullPage:true});
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No mobile horizontal overflow');
await page.goto('http://127.0.0.1:3188/admin.html');await page.locator('#password').fill(password);await page.getByRole('button',{name:'Se connecter'}).click();await page.locator('#dashboard').waitFor({state:'visible'});
await page.getByRole('button',{name:'Ajouter une monture'}).click();await page.locator('[name=name]').fill('Browser test');await page.locator('[name=brand]').fill('Test');await page.getByRole('button',{name:'Enregistrer',exact:true}).click();await page.getByText('Monture enregistrée.').waitFor();
page.on('dialog',d=>d.accept());const row=page.locator('.row').filter({hasText:'Browser test'});await row.getByRole('button',{name:'Supprimer'}).click();await row.waitFor({state:'detached'});
assert.deepEqual(errors,[]);console.log('PASS: desktop catalogue, try dialog, mobile layout, admin login and product create/delete; no page errors.');
}finally{await browser?.close();child.kill()}
