// Offline replacement of the requested product's model only. Stop tryit first.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
export async function upgradeProduct(project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
 const db=path.join(project,'data/catalog.json');
 const items=JSON.parse(await fs.readFile(db,'utf8'));
 const product=items.find(p=>p.id==='head-12028-col400');
 if(!product)throw Error('HEAD 12028 is not present. Run the initial import first, then rerun this upgrade.');
 const model=await fs.readFile(path.join(project,'public/products/head-12028/head-12028-generated.glb'));
 if(model.toString('ascii',0,4)!=='glTF'||model.readUInt32LE(4)!==2||model.readUInt32LE(8)!==model.length||model.length>25*1024*1024)throw Error('Invalid or oversized GLB');
 const hash=crypto.createHash('sha256').update(model).digest('hex');
 const name=`head-12028-generated-${hash.slice(0,16)}.glb`;
 const uri='/uploads/'+name;
 await fs.mkdir(path.join(project,'uploads'),{recursive:true});
 const destination=path.join(project,'uploads',name);
 try{await fs.writeFile(destination,model,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.readFile(destination)).equals(model))throw Error('Existing asset differs from expected content.');}
 if(product.model===uri){console.log('Generated model already installed; catalogue unchanged.');return false;}
 product.previousModel=product.model;
 product.model=uri;
 product.modelSource='Owner-provided GitHub release model-v1, optimized for web';
 product.estimatedDimensions=true;
 const temporary=db+'.upgrade-'+crypto.randomUUID();
 await fs.writeFile(temporary,JSON.stringify(items,null,2));
 await fs.rename(temporary,db);
 console.log('HEAD 12028 model upgraded. Product settings, images and other products preserved.');
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await upgradeProduct();
