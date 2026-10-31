import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const SIZES=new Set([128,800,1600]);
const MAX_PIXELS=64*1024*1024,MAX_SOURCE_BYTES=10*1024*1024;
const failure=(status,message)=>Object.assign(new Error(message),{status});
const inside=(base,file)=>file.startsWith(base+path.sep);

// Originals keep their public URLs and contents. The lazy endpoint applies to
// old and new photos equally, and stores disposable derivatives outside uploads.
export function createProductImages(root,{maxPending=64,onGenerate=()=>{}}={}){
  const cache=path.join(root,'data/image-cache-v1');
  const sourceCache=new Map(),inflight=new Map();let queue=Promise.resolve(),pending=0;
  async function sourceInfo(src){
    if(typeof src!=='string'||src.length>600||!/^\/(uploads|products)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:jpe?g|png|webp)$/i.test(src)
      ||src.split('/').some(part=>part==='.'||part==='..'))throw failure(400,'Photo non prise en charge.');
    const folder=src.startsWith('/uploads/')?'uploads':'public/products';
    const base=await fs.realpath(path.join(root,folder)).catch(()=>null);
    if(!base)throw failure(404,'Photo indisponible.');
    const requested=path.join(root,src.startsWith('/uploads/')?src.slice(1):'public'+src);
    const file=await fs.realpath(requested).catch(()=>null);
    if(!file||!inside(base,file))throw failure(404,'Photo indisponible.');
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>MAX_SOURCE_BYTES||stat.size===0)throw failure(400,'Photo non prise en charge.');
    const signature=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const previous=sourceCache.get(file);
    if(previous?.signature===signature)return previous.promise;
    const promise=(async()=>{
      const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
      return {file,hash:hash.digest('hex'),immutable:src.startsWith('/uploads/')};
    })();
    sourceCache.set(file,{signature,promise});
    // Bound metadata retention; byte hashing is shared across all sizes of a
    // source and repeated GETs when size/mtime/ctime have not changed.
    if(sourceCache.size>256)sourceCache.delete(sourceCache.keys().next().value);
    promise.catch(()=>{if(sourceCache.get(file)?.promise===promise)sourceCache.delete(file);});
    return promise;
  }
  async function prepare(src,size){
    if(!SIZES.has(size))throw failure(400,'Taille de photo non prise en charge.');
    const source=await sourceInfo(src);
    const key=crypto.createHash('sha256').update(`image-v1:q90:width${size}:${source.hash}`).digest('hex');
    const destination=path.join(cache,key+'.webp');
    const found=await fs.stat(destination).catch(()=>null);
    if(found?.isFile())return {file:destination,key,immutable:source.immutable,size:found.size};
    if(inflight.has(key))return inflight.get(key);
    if(pending>=maxPending)throw failure(503,'Les photos sont en préparation. Réessayez dans un instant.');
    pending++;
    const job=queue.then(async()=>{
      await fs.mkdir(cache,{recursive:true,mode:0o700});
      const temporary=path.join(cache,`${key}-${crypto.randomUUID()}.tmp`);
      try{
        await onGenerate({src,size});
        // Limit decode pixels and serialize transforms so visitors cannot start
        // multiple full-resolution Sharp decoders in the server simultaneously.
        try{await sharp(source.file,{limitInputPixels:MAX_PIXELS,animated:false}).rotate()
          .resize({width:size,height:size*2,fit:'inside',withoutEnlargement:true}).webp({quality:90,effort:4}).toFile(temporary);}
        catch{throw failure(422,'Cette photo ne peut pas être préparée.');}
        await fs.rename(temporary,destination);
        const stat=await fs.stat(destination);
        return {file:destination,key,immutable:source.immutable,size:stat.size};
      }finally{await fs.unlink(temporary).catch(()=>{});}
    }).finally(()=>{pending--;inflight.delete(key);});
    inflight.set(key,job);queue=job.catch(()=>{});return job;
  }
  async function middleware(req,res,next){
    if(!['GET','HEAD'].includes(req.method))return next();
    const match=req.path.match(/^\/v1\/(128|800|1600)$/);
    if(!match)return next();
    try{
      const image=await prepare(req.query.src,Number(match[1]));
      res.type('image/webp');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('ETag',`"${image.key}"`);
      res.sendFile(image.file,{maxAge:image.immutable?'1y':0,immutable:image.immutable},error=>{if(error)next(error);});
    }catch(error){
      const status=error.status||500;
      if(status===503)res.setHeader('Retry-After','1');
      res.status(status).json({error:status===500?'Photo indisponible.':error.message});
    }
  }
  return {prepare,middleware};
}
