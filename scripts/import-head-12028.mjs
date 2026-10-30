// Offline, additive import. Stop the application before running on production.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
export async function importProduct(project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
 const db=path.join(project,'data/catalog.json');
 const items=JSON.parse(await fs.readFile(db,'utf8'));
 const id='head-12028-col400';
 if(items.some(p=>p.id===id)){console.log('model-v1 HEAD product already exists; administrator edits preserved.');return false}
 const source=path.join(project,'public/products/head-12028');
 const image=await fs.readFile(path.join(source,'front.jpg'));
 const model=await fs.readFile(path.join(source,'head-12028-col400.glb'));
 if(model.toString('ascii',0,4)!=='glTF'||model.readUInt32LE(4)!==2||model.readUInt32LE(8)!==model.length)throw Error('Invalid GLB');
 await fs.mkdir(path.join(project,'uploads'),{recursive:true});
 const assets={};
 for(const [field,bytes,ext] of [['image',image,'jpg'],['model',model,'glb']]){
  const name=`head-12028-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)}.${ext}`;
  const destination=path.join(project,'uploads',name);
  try{await fs.writeFile(destination,bytes,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.readFile(destination)).equals(bytes))throw Error('Existing asset differs: '+name)}
  assets[field]='/uploads/'+name;
 }
 // Keep the historical ID/path; the owner later identified model-v1 as 12029.
 items.push({id,name:'12029',brand:'HEAD',visible:true,demo:false,estimatedDimensions:true,imageFit:'cover',scale:1,offset:0,...assets});
 const temporary=db+'.import-'+crypto.randomUUID();
 await fs.writeFile(temporary,JSON.stringify(items,null,2));
 await fs.rename(temporary,db);
 console.log('Added HEAD 12029 (model-v1, photo approximation). Existing products preserved.');return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await importProduct();
