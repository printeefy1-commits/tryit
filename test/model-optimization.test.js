import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {draco as compressDraco} from '@gltf-transform/functions';
import draco from 'draco3dgltf';
import {MeshoptDecoder} from 'meshoptimizer';
import {optimizeModel} from '../model-optimizer.js';
import {validateModel} from '../upload-validation.js';

function vertexSets(doc){
 const result={};
 for(const mesh of doc.getRoot().listMeshes())for(const primitive of mesh.listPrimitives()){
  const key=primitive.getMaterial()?.getName()||'',rows=new Set();
  for(let vertex=0;vertex<primitive.getAttribute('POSITION').getCount();vertex++){
   const row=[];
   for(const semantic of primitive.listSemantics().sort()){
    const attribute=primitive.getAttribute(semantic),value=attribute.getArray().subarray(vertex*attribute.getElementSize(),(vertex+1)*attribute.getElementSize());
    row.push(semantic+':'+Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex'));
   }
   rows.add(row.join('|'));
  }
  result[key]=[...(new Set([...(result[key]||[]),...rows]))].sort();
 }
 return result;
}

test('a web-ready authored GLB keeps full-precision vertices, materials and fitting metadata under Meshopt compression',async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'tryit-compression-test-'));
 try{
  const source=new URL('../public/products/models-v2/head-blue.glb',import.meta.url).pathname,output=path.join(temporary,'web.glb');
  const original=await fs.readFile(source),hash=createHash('sha256').update(original).digest('hex');
  const report=await optimizeModel(source,output);assert.equal(report.trianglesBefore,report.trianglesAfter);assert.ok(report.outputBytes<original.length*.5);assert.ok(report.transferBytes<report.outputBytes);
  assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'),hash,'source is untouched');
  await validateModel({path:output,size:report.outputBytes,originalname:'web.glb'});
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  const before=await io.read(source),after=await io.read(output);
  assert.deepEqual(vertexSets(before),vertexSets(after),'every vertex attribute remains bitwise identical; only order changes');
  assert.deepEqual(before.getRoot().getAsset().extras,after.getRoot().getAsset().extras);
  const materials=doc=>doc.getRoot().listMaterials().map(m=>({name:m.getName(),colour:m.getBaseColorFactor(),roughness:m.getRoughnessFactor(),metalness:m.getMetallicFactor(),alpha:m.getAlphaMode(),sides:m.getDoubleSided(),extensions:m.listExtensions().map(e=>e.extensionName).sort()}));
  assert.deepEqual(materials(before),materials(after));
  const second=path.join(temporary,'second.glb');await optimizeModel(output,second);assert.deepEqual(vertexSets(await io.read(second)),vertexSets(after),'uploaded Meshopt input remains supported');
  const malformed=await fs.readFile(output),length=malformed.readUInt32LE(12),json=JSON.parse(malformed.subarray(20,20+length));
  assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
  // A compressed reference may use a URI-less fallback buffer, but its actual
  // compressed byte range must still be within the GLB's physical BIN chunk.
  const view=json.bufferViews.find(v=>v.extensions?.EXT_meshopt_compression);view.extensions.EXT_meshopt_compression.byteOffset=99999999;
  let encoded=Buffer.from(JSON.stringify(json));encoded=Buffer.concat([encoded,Buffer.alloc((4-encoded.length%4)%4,32)]);
  const corrupt=Buffer.concat([malformed.subarray(0,20),encoded,malformed.subarray(20+length)]);corrupt.writeUInt32LE(corrupt.length,8);corrupt.writeUInt32LE(encoded.length,12);
  const corruptPath=path.join(temporary,'bad.glb');await fs.writeFile(corruptPath,corrupt);
  await assert.rejects(validateModel({path:corruptPath,size:corrupt.length,originalname:'bad.glb'}),/Meshopt.*invalides/);
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});

test('an abandoned optimization is cancelled before consuming worker resources',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(optimizeModel('/unused/source.glb','/unused/output.glb',{signal:controller.signal}),/annulée/);
});

test('a previously Draco-compressed GLB can be processed without requiring a second geometry encoder',async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'tryit-draco-test-'));
 try{
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.encoder':await draco.createEncoderModule(),'draco3d.decoder':await draco.createDecoderModule(),'meshopt.decoder':MeshoptDecoder});
  const doc=await io.read(new URL('../public/products/models-v2/head-blue.glb',import.meta.url).pathname);await doc.transform(compressDraco());
  const input=path.join(temporary,'draco.glb'),output=path.join(temporary,'web.glb');await io.write(input,doc);
  const size=(await fs.stat(input)).size;await validateModel({path:input,size,originalname:'draco.glb'});
  const report=await optimizeModel(input,output);assert.ok(report.outputBytes<=size);assert.equal(report.trianglesBefore,74998);assert.equal(report.trianglesAfter,74998);
  await validateModel({path:output,size:report.outputBytes,originalname:'web.glb'});assert.equal((await io.read(output)).getRoot().listMeshes().length,doc.getRoot().listMeshes().length);
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});

test('cancelling an active preparation leaves its source untouched and does not publish an output',async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'tryit-abort-test-'));
 try{
  const input=new URL('../public/products/models-v2/head-blue.glb',import.meta.url).pathname,output=path.join(temporary,'web.glb');
  const controller=new AbortController(),request=optimizeModel(input,output,{signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),20);
  await assert.rejects(request,/annulée/);clearTimeout(timer);
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
  assert.equal((await fs.stat(input)).size,2051856);
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
