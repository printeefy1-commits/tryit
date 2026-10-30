// Additive, offline import. Stop tryit before running against production data.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export async function readReleaseAssets(source,entry){
  const assets={};
  for(const field of ['model','image']){
    const file=entry[field];if(path.basename(file)!==file)throw Error('Invalid asset filename');
    const bytes=await fs.readFile(path.join(source,file));
    if(field==='model'){
      if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.length>25*1024*1024)throw Error('Invalid or oversized GLB');
      const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
      if(gltf.asset?.extras?.lunetteCaba?.sourceSha256!==entry.sourceSha256)throw Error('Model provenance mismatch');
      if(gltf.buffers.some(b=>b.uri)||gltf.images?.some(i=>i.uri))throw Error('Model must contain its textures');
    }else if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw Error('Invalid preview');
    const name=`${entry.id}-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)}${path.extname(file)}`;
    assets[field]={bytes,name};
  }
  return assets;
}

export async function copyReleaseAssets(project,assets){
  await fs.mkdir(path.join(project,'uploads'),{recursive:true});
  const uris={};
  for(const [field,{bytes,name}] of Object.entries(assets)){
    const destination=path.join(project,'uploads',name);
    try{await fs.writeFile(destination,bytes,{flag:'wx'});}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(!(await fs.readFile(destination)).equals(bytes))throw Error('Existing asset differs: '+name);
    }
    uris[field]='/uploads/'+name;
  }
  return uris;
}

export async function importModels(project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')){
  const db=path.join(project,'data/catalog.json'),source=path.join(project,'public/products/models-v2');
  const items=JSON.parse(await fs.readFile(db,'utf8'));
  const entries=JSON.parse(await fs.readFile(path.join(source,'catalog.json'),'utf8'));
  const pending=[];
  for(const entry of entries){
    if(items.some(p=>p.id===entry.id))continue; // Preserve all administrator edits.
    const assets=await readReleaseAssets(source,entry);
    pending.push({entry,assets});
  }
  // The owner corrected model-v1's number to 12029. Keep its legacy ID and
  // asset paths so saved settings still refer to the same product. Rename only
  // the original seeded labels; do not replace a custom administrator name.
  const previous=items.find(p=>p.id==='head-12028-col400'&&p.brand==='HEAD');
  const corrected=!!previous&&['12028','HEAD 12028'].includes(previous.name);
  if(corrected)previous.name=previous.name.replace('12028','12029');
  if(!pending.length&&!corrected){console.log('models-v2 already installed; catalogue and administrator edits preserved.');return false;}
  await fs.mkdir(path.join(project,'uploads'),{recursive:true});
  for(const {entry,assets} of pending){
    const uris=await copyReleaseAssets(project,assets);
    items.push({id:entry.id,name:entry.name,brand:entry.brand,visible:true,demo:false,estimatedDimensions:true,
      scale:1,offset:0,...uris,modelSource:entry.sourceRelease,sourceSha256:entry.sourceSha256});
  }
  const temporary=db+'.models-v2-'+crypto.randomUUID();
  try{await fs.writeFile(temporary,JSON.stringify(items,null,2));await fs.rename(temporary,db);}
  finally{await fs.rm(temporary,{force:true});}
  console.log(`Added ${pending.length} models-v2 product(s).${corrected?' Corrected model-v1 display name to HEAD 12029.':''} Existing settings preserved.`);return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await importModels();
