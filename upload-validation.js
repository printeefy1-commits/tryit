import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import heicConvert from 'heic-convert';
import {MODEL_MAX_BYTES,IMAGE_MAX_BYTES} from './public/upload-config.js';

export async function validateModel(file){
  if(file.size>MODEL_MAX_BYTES)throw Error('Le modèle dépasse 100 Mo.');
  const handle=await fs.open(file.path,'r');
  try{
    const header=Buffer.alloc(20);await handle.read(header,0,20,0);
    if(file.size<20||header.toString('ascii',0,4)!=='glTF'||header.readUInt32LE(4)!==2||header.readUInt32LE(8)!==file.size)throw Error('Le fichier n’est pas un GLB valide.');
    const jsonLength=header.readUInt32LE(12);
    if(header.readUInt32LE(16)!==0x4e4f534a||jsonLength<2||jsonLength>8*1024*1024||jsonLength%4||20+jsonLength>file.size)throw Error('Structure GLB invalide.');
    const json=Buffer.alloc(jsonLength);await handle.read(json,0,jsonLength,20);
    let doc;try{doc=JSON.parse(json.toString('utf8'));}catch{throw Error('Le contenu du GLB est illisible.');}
    if(doc.asset?.version!=='2.0'||!doc.meshes?.some(m=>m.primitives?.some(p=>p.attributes?.POSITION!==undefined))||!doc.scenes?.length)throw Error('Le GLB ne contient pas de modèle 3D affichable.');
    if(doc.buffers?.some(b=>b.uri)||doc.images?.some(i=>i.uri))throw Error('Exportez un GLB autonome avec toutes ses textures intégrées.');
    if(doc.extensionsUsed?.includes('KHR_texture_basisu')||doc.extensionsRequired?.includes('KHR_texture_basisu'))throw Error('Exportez les textures en PNG, JPEG ou WebP, sans compression KTX2.');
    const binHeader=Buffer.alloc(8),offset=20+jsonLength;
    await handle.read(binHeader,0,8,offset);
    if(offset+8>file.size||binHeader.readUInt32LE(4)!==0x004e4942||offset+8+binHeader.readUInt32LE(0)!==file.size)throw Error('Les données du GLB sont incomplètes.');
    const binaryLength=binHeader.readUInt32LE(0);
    if(!doc.buffers?.length||!Number.isInteger(doc.buffers[0].byteLength)||doc.buffers[0].byteLength>binaryLength||doc.buffers[0].byteLength<binaryLength-3)throw Error('Les données du GLB sont incomplètes.');
    const meshopt=doc.extensionsRequired?.includes('EXT_meshopt_compression'),decodedLimit=256*1024*1024;
    for(const buffer of doc.buffers.slice(1))if(!meshopt||buffer.extensions?.EXT_meshopt_compression?.fallback!==true||!Number.isInteger(buffer.byteLength)||buffer.byteLength<0||buffer.byteLength>decodedLimit)throw Error('Les données du GLB sont incomplètes.');
    let decodedBytes=0;
    for(const view of doc.bufferViews||[]){
      if(!Number.isInteger(view.buffer)||!doc.buffers[view.buffer]||!Number.isInteger(view.byteLength)||view.byteLength<0||!Number.isInteger(view.byteOffset??0)||(view.byteOffset??0)<0||(view.byteOffset??0)+view.byteLength>doc.buffers[view.buffer].byteLength)throw Error('Le GLB contient des références de données invalides.');
      const compressed=view.extensions?.EXT_meshopt_compression;
      if(view.buffer!==0&&!compressed)throw Error('Le GLB contient des références de données invalides.');
      if(compressed){
        if(compressed.buffer!==0||!Number.isInteger(compressed.byteOffset??0)||(compressed.byteOffset??0)<0||!Number.isInteger(compressed.byteLength)||compressed.byteLength<0||(compressed.byteOffset??0)+compressed.byteLength>doc.buffers[0].byteLength||!Number.isInteger(compressed.count)||compressed.count<0||!Number.isInteger(compressed.byteStride)||compressed.byteStride<1||compressed.byteStride>256||compressed.count*compressed.byteStride!==view.byteLength)throw Error('Les données Meshopt du GLB sont invalides.');
        decodedBytes+=view.byteLength;if(decodedBytes>decodedLimit)throw Error('Le modèle décompressé est trop complexe. Réduisez le nombre de triangles.');
      }
    }
  }finally{await handle.close();}
  const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file.path))hash.update(chunk);
  return {sourceSha256:hash.digest('hex'),modelBytes:file.size,modelFileName:path.basename(file.originalname).slice(0,150)};
}

export async function validatePhoto(file){
  if(file.size>IMAGE_MAX_BYTES)throw Error('La photo dépasse 10 Mo.');
  const bytes=await fs.readFile(file.path),ext=path.extname(file.originalname).toLowerCase();
  if(['.heic','.heif'].includes(ext)){
    if(bytes.toString('ascii',4,8)!=='ftyp')throw Error('La photo HEIC est invalide.');
    let converted;try{converted=await heicConvert({buffer:bytes,format:'JPEG',quality:.88});}catch{throw Error('Impossible de convertir cette photo HEIC. Choisissez une photo JPG, PNG ou WebP.');}
    if(converted.byteLength>IMAGE_MAX_BYTES)throw Error('La photo convertie dépasse 10 Mo. Réduisez sa résolution.');
    const convertedPath=file.path+'.jpg';await fs.writeFile(convertedPath,Buffer.from(converted));await fs.unlink(file.path);
    file.path=convertedPath;file.filename=path.basename(convertedPath);file.size=converted.byteLength;
    return;
  }
  const valid=['.jpg','.jpeg'].includes(ext)?bytes[0]===255&&bytes[1]===216:ext==='.png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):ext==='.webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!valid)throw Error('Photo invalide. Choisissez un JPG, PNG, WebP ou HEIC.');
}
