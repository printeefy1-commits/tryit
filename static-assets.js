import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';

const brotli=promisify(brotliCompress),zip=promisify(gzip);
const compressible=/\.(?:m?js|css|json|wasm|task|svg|txt)$/i;
async function files(directory,prefix){
 let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const result=[];
 for(const entry of entries){
  if(entry.name.startsWith('.'))continue;
  const filename=path.join(directory,entry.name),url=prefix+'/'+entry.name;
  if(entry.isDirectory())result.push(...await files(filename,url));
  else if(entry.isFile())result.push({filename,url});
 }
 return result;
}
async function atomicWrite(filename,bytes){
 try{await fs.access(filename);return;}catch{}
 const temporary=filename+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(temporary,bytes,{mode:0o600});await fs.rename(temporary,filename);}
 finally{await fs.unlink(temporary).catch(()=>{});}
}

// Immutable URLs identify a complete asset snapshot, never a mutable filename.
// Content-addressed files are shared across builds. Old snapshots remain valid
// while a process finishes serving requests during a git/npm deployment.
export async function createStaticAssets({root,cacheDirectory=path.join(root,'data/static-cache')}={}){
 await fs.mkdir(cacheDirectory,{recursive:true,mode:0o700});
 const publicRoot=path.join(root,'public'),manifest=new Map(),htmlSources=new Map();
 const list=[...await files(path.join(root,'node_modules/three'),'/vendor/three'),
  ...await files(path.join(root,'node_modules/@mediapipe/tasks-vision'),'/vendor/vision'),
  ...await files(path.join(publicRoot,'models'),'/models'),...await files(path.join(publicRoot,'assets'),'/assets')];
 for(const entry of await fs.readdir(publicRoot,{withFileTypes:true}))if(entry.isFile()&&/\.(?:m?js|css|html)$/.test(entry.name)){
  if(entry.name.endsWith('.html'))htmlSources.set('/'+entry.name,await fs.readFile(path.join(publicRoot,entry.name),'utf8'));
  else list.push({filename:path.join(publicRoot,entry.name),url:'/'+entry.name});
 }
 let cursor=0;
 await Promise.all(Array.from({length:4},async()=>{
  while(cursor<list.length){
   const {filename,url}=list[cursor++],bytes=await fs.readFile(filename),digest=createHash('sha256').update(bytes).digest('hex');
   const snapshot=path.join(cacheDirectory,digest+'.identity');await atomicWrite(snapshot,bytes);
   manifest.set(url,{filename:snapshot,digest,size:bytes.length,extension:path.extname(url)});
  }
 }));
 const hash=createHash('sha256');
 hash.update(await fs.readFile(new URL(import.meta.url))); // Include URL transformation semantics in the build identity.
 for(const [url,record] of [...manifest].sort(([a],[b])=>a.localeCompare(b)))hash.update(url+'\0'+record.digest+'\n');
 for(const [url,html] of [...htmlSources].sort(([a],[b])=>a.localeCompare(b)))hash.update(url+'\0'+html+'\n');
 const build=hash.digest('hex').slice(0,20),prefix='/assets-v/'+build;
 const url=pathname=>prefix+pathname;
 // CSS root URLs must agree with HTML's versioned font preloads; otherwise
 // the same font would be downloaded under both legacy and immutable URLs.
 for(const [pathname,record] of manifest)if(pathname.endsWith('.css')&&!pathname.startsWith('/vendor/')){
  const original=await fs.readFile(record.filename,'utf8');
  const body=original.replace(/url\(\s*(["']?)(\/assets\/[^)"'\s]+)\1\s*\)/g,(_,quote,asset)=>`url(${quote}${url(asset)}${quote})`);
  if(body===original)continue;
  const bytes=Buffer.from(body),digest=createHash('sha256').update(bytes).digest('hex'),snapshot=path.join(cacheDirectory,digest+'.identity');
  await atomicWrite(snapshot,bytes);manifest.set(pathname,{...record,filename:snapshot,digest,size:bytes.length});
 }
 const importMap=JSON.stringify({imports:{three:url('/vendor/three/build/three.module.js'),'three/addons/':url('/vendor/three/examples/jsm/')}});
 const importMapHash="'sha256-"+createHash('sha256').update(importMap).digest('base64')+"'";
 const html=new Map([...htmlSources].map(([name,source])=>[name,source
  .replace(/(<script\s+type=["']importmap["']>)[\s\S]*?(<\/script>)/g,(_,start,end)=>start+importMap+end)
  .replace(/\b(src|href)=(["'])(\/(?:assets\/[^"'?]+|[^\/"'?]+\.(?:m?js|css)))(\?[^"']*)?\2/g,(_,attribute,quote,pathname,query='')=>`${attribute}=${quote}${url(pathname)}${query}${quote}`)]));
 let compressionQueue=Promise.resolve();const pending=new Map();
 function compressed(record,encoding){
  const key=record.digest+'.'+encoding;
  if(pending.has(key))return pending.get(key);
  const job=compressionQueue.then(async()=>{
   const filename=path.join(cacheDirectory,key);
   try{return {filename,size:(await fs.stat(filename)).size};}catch{}
   const bytes=await fs.readFile(record.filename),encoded=encoding==='br'
    ?await brotli(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:6}}):await zip(bytes,{level:6});
   await atomicWrite(filename,encoded);return {filename,size:encoded.length};
  });
  pending.set(key,job);compressionQueue=job.catch(()=>{});
  job.catch(()=>pending.delete(key));return job;
 }
 async function middleware(req,res,next){
  if(!['GET','HEAD'].includes(req.method))return next();
  let pathname;try{pathname=decodeURIComponent(req.path);}catch{return res.sendStatus(400);}
  let immutable=false;
  if(pathname.startsWith('/assets-v/')){
   if(!pathname.startsWith(prefix+'/'))return res.status(404).set('Cache-Control','no-store').end();
   pathname=pathname.slice(prefix.length);immutable=true;
  }
  const record=manifest.get(pathname);
  if(!record)return immutable?res.status(404).set('Cache-Control','no-store').end():next();
  try{
   let encoding='identity',representation={filename:record.filename,size:record.size};
   const canCompress=compressible.test(pathname)&&record.size>=1024;
   res.vary('Accept-Encoding');
   const offered=req.get('Accept-Encoding')?req.acceptsEncodings(...(canCompress?['br','gzip','identity']:['identity'])):'identity';
   if(!offered)return res.sendStatus(406);
   if(canCompress){
    encoding=req.get('range')?'identity':offered;
    if(encoding==='identity'&&!req.acceptsEncodings('identity'))return res.sendStatus(406);
    if(encoding!=='identity'){
     representation=await compressed(record,encoding);
     // Do not enlarge a compact file unless identity was explicitly refused.
     if(representation.size>=record.size&&req.acceptsEncodings('identity')){encoding='identity';representation={filename:record.filename,size:record.size};}
    }
   }
   res.type(record.extension||'application/octet-stream');
   if(encoding!=='identity')res.set('Content-Encoding',encoding);
   res.set({'X-Asset-Bytes':String(record.size),'X-Model-Bytes':String(record.size),
    'ETag':'"'+record.digest+'-'+encoding+'"','Cache-Control':immutable?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate'});
   res.sendFile(representation.filename,{etag:false,lastModified:false,cacheControl:false},error=>{if(error)next(error);});
  }catch(error){next(error);}
 }
 function htmlMiddleware(req,res,next){
  if(!['GET','HEAD'].includes(req.method))return next();
  const name=req.path==='/'?'/index.html':req.path,body=html.get(name);
  if(!body)return next();
  res.type('html').set('Cache-Control','no-store').send(body);
 }
 return {build,prefix,url,importMap,importMapHash,middleware,htmlMiddleware};
}
