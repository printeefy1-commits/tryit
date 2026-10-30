// Owner-requested replacement of the model only. Stop tryit before running.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readReleaseAssets,copyReleaseAssets} from './import-models-v2.mjs';

export async function updateModels(project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')){
  const db=path.join(project,'data/catalog.json'),source=path.join(project,'public/products/models-v2');
  const items=JSON.parse(await fs.readFile(db,'utf8'));
  const entries=JSON.parse(await fs.readFile(path.join(source,'catalog.json'),'utf8'));
  const pending=[];
  for(const entry of entries){
    const product=items.find(p=>p.id===entry.id);
    if(!product)throw Error('models-v2 product is not present. Run node scripts/import-models-v2.mjs first.');
    const assets=await readReleaseAssets(source,entry);
    if(product.model==='/uploads/'+assets.model.name)continue;
    pending.push({entry,product,assets});
  }
  if(!pending.length){console.log('Latest models-v2 GLB already installed; catalogue unchanged.');return false;}
  for(const {entry,product,assets} of pending){
    const uris=await copyReleaseAssets(project,assets);
    product.previousModel=product.model;
    if(product.sourceSha256)product.previousModelSourceSha256=product.sourceSha256;
    product.model=uris.model;product.sourceSha256=entry.sourceSha256;product.modelSource=entry.sourceRelease;
    // Refresh our generated thumbnail, but preserve a photo uploaded by the owner.
    if(entry.previousGeneratedImages?.includes(product.image)){
      product.previousImage=product.image;product.image=uris.image;
    }
  }
  const temporary=db+'.models-v2-update-'+crypto.randomUUID();
  try{await fs.writeFile(temporary,JSON.stringify(items,null,2));await fs.rename(temporary,db);}
  finally{await fs.rm(temporary,{force:true});}
  console.log(`Updated ${pending.length} models-v2 GLB(s). Product settings and previous files preserved.`);return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await updateModels();
