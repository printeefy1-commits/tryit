// Apply the two photos explicitly selected by the owner. Stop tryit first.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {copyReleaseAssets} from './import-models-v2.mjs';

const photos=[
  {id:'head-12028-col400',number:'12029',file:'public/products/head-12028/front.jpg'},
  {id:'head-12028-models-v2',number:'12028',file:'public/products/models-v2/product.webp'}
];

export async function updatePhotos(project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')){
  const db=path.join(project,'data/catalog.json'),items=JSON.parse(await fs.readFile(db,'utf8')),pending=[];
  for(const photo of photos){
    const product=items.find(p=>p.id===photo.id);
    if(!product)throw Error(`HEAD ${photo.number} is not present. Import the product before applying its photo.`);
    const bytes=await fs.readFile(path.join(project,photo.file)),ext=path.extname(photo.file);
    const valid=ext==='.jpg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!valid)throw Error(`Invalid photo for HEAD ${photo.number}`);
    const name=`head-${photo.number}-photo-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)}${ext}`;
    const uri='/uploads/'+name;
    if(product.image!==uri||product.imageFit!=='contain')pending.push({product,bytes,name,uri});
  }
  if(!pending.length){console.log('Selected product photos already installed; catalogue unchanged.');return false;}
  for(const {product,bytes,name,uri} of pending){
    await copyReleaseAssets(project,{image:{bytes,name}});
    if(product.image!==uri&&product.image)product.previousImage=product.image;
    product.image=uri;product.imageFit='contain';
  }
  const temporary=db+'.photos-'+crypto.randomUUID();
  try{await fs.writeFile(temporary,JSON.stringify(items,null,2));await fs.rename(temporary,db);}
  finally{await fs.rm(temporary,{force:true});}
  console.log(`Updated ${pending.length} product photo(s). Models and fitting settings preserved.`);return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await updatePhotos();
