// Runs only in the bounded child process, never on Express's event loop.
import {NodeIO,Logger} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression,EXTTextureWebP} from '@gltf-transform/extensions';
import {weld,reorder,simplifyPrimitive,compressTexture,listTextureSlots,prune} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder,MeshoptSimplifier} from 'meshoptimizer';
import draco from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import {knownFittingAnchor} from './public/tryon-model-profiles.js';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';

import {MODEL_OPTIMIZATION_VERSION as OPTIMIZATION_VERSION} from './public/upload-config.js';
const MAX_TEXTURE=2048,TRIANGLE_TARGET=100000,ERROR_LIMIT=.001;
sharp.cache(false);sharp.concurrency(1);
const encodeBrotli=promisify(brotliCompress),encodeGzip=promisify(gzip);
function triangles(doc){return doc.getRoot().listMeshes().flatMap(mesh=>mesh.listPrimitives()).reduce((n,p)=>n+(p.getMode()===4?(p.getIndices()?.getCount()||p.getAttribute('POSITION')?.getCount()||0)/3:0),0);}

export async function optimizeModelFile(input,output){
  const started=Date.now(),source=await fs.readFile(input),jsonLength=source.readUInt32LE(12),json=JSON.parse(source.subarray(20,20+jsonLength));
  const supported=new Set(ALL_EXTENSIONS.map(extension=>extension.EXTENSION_NAME));
  // Never silently strip unsupported optional extensions (e.g. authored variants).
  if((json.extensionsUsed||[]).some(name=>!supported.has(name)))throw Error('Une extension de ce GLB ne peut pas être optimisée sans modifier son rendu. Exportez un GLB standard.');
  await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready,MeshoptSimplifier.ready]);
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder,'draco3d.decoder':await draco.createDecoderModule()
  });
  const doc=await io.readBinary(source);doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const before=triangles(doc),root=doc.getRoot();
  // Reading already decoded these codecs. Remove the old encoding policy so
  // a Draco input is not accidentally recompressed with two encoders.
  for(const extension of root.listExtensionsUsed())if(['KHR_draco_mesh_compression','EXT_meshopt_compression'].includes(extension.extensionName))extension.dispose();
  const asset=root.getAsset(),known=knownFittingAnchor(createHash('sha256').update(source).digest('hex'));
  if(!asset.extras?.lunetteCaba&&known)asset.extras={...asset.extras,lunetteCaba:known};
  // Retain authoring metadata, names, transforms, materials and custom fitting anchors.
  // No flatten/join or POSITION quantization: the try-on bends the rear temples
  // and requires mutable float positions with the original coordinate system.
  await doc.transform(weld());
  if(before>TRIANGLE_TARGET&&!root.listSkins().length&&!root.listAnimations().length){
    const ratio=TRIANGLE_TARGET/before;
    for(const mesh of root.listMeshes())for(const primitive of mesh.listPrimitives()){
      if(primitive.getMode()!==4||primitive.listTargets().length||!primitive.getIndices())continue;
      simplifyPrimitive(primitive,{simplifier:MeshoptSimplifier,ratio,error:ERROR_LIMIT,lockBorder:true});
    }
  }
  for(const texture of root.listTextures()){
    const image=texture.getImage(),mime=texture.getMimeType(),uri=texture.getURI();if(!image)continue;
    const slots=listTextureSlots(texture),colourOnly=slots.length>0&&slots.every(slot=>/^(baseColorTexture|emissiveTexture)$/.test(slot));
    // Colour maps use high-quality WebP. Normal/data channels use lossless WebP;
    // all maps retain aspect ratio, at up to 2048px (no forced upscaling).
    await compressTexture(texture,{encoder:sharp,targetFormat:'webp',resize:[MAX_TEXTURE,MAX_TEXTURE],quality:95,lossless:!colourOnly,effort:4});
    if(texture.getImage().byteLength>=image.byteLength){texture.setImage(image).setMimeType(mime).setURI(uri);}
  }
  if(root.listTextures().some(texture=>texture.getMimeType()==='image/webp'))doc.createExtension(EXTTextureWebP).setRequired(true);
  await doc.transform(reorder({encoder:MeshoptEncoder,target:'size'}),prune({keepAttributes:true,keepLeaves:true}));
  // QUANTIZE here selects the lossless codec; no quantize() transform or lossy
  // filter is applied. Float vertex positions/normals/UVs remain full precision.
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
  let bytes=await io.writeBinary(doc),after=triangles(doc),status='optimized';
  if(!after&&before)throw Error('Le modèle optimisé est vide.');
  if(bytes.byteLength>=source.byteLength){bytes=source;after=before;status='unchanged';}
  await fs.writeFile(output,bytes);
  // Transport compression is lossless. Its sidecars are served only when the
  // browser accepts that encoding, with a normal GLB fallback.
  const br=await encodeBrotli(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:6}}),gz=await encodeGzip(bytes,{level:6});
  if(br.byteLength<bytes.byteLength)await fs.writeFile(output+'.br',br);
  if(gz.byteLength<bytes.byteLength)await fs.writeFile(output+'.gz',gz);
  return {version:OPTIMIZATION_VERSION,status,originalBytes:source.byteLength,outputBytes:bytes.byteLength,
    transferBytes:Math.min(bytes.byteLength,br.byteLength),trianglesBefore:before,trianglesAfter:after,
    maxTextureSize:MAX_TEXTURE,colourQuality:95,maxSimplificationError:before!==after?ERROR_LIMIT:0,
    sha256:createHash('sha256').update(bytes).digest('hex'),durationMs:Date.now()-started};
}
