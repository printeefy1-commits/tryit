import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import {rateLimit} from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateModel,validatePhoto} from './upload-validation.js';
import {MODEL_MAX_BYTES} from './public/upload-config.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const app=express(); const prod=process.env.NODE_ENV==='production';
if(!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length<12) throw Error('Set ADMIN_PASSWORD (at least 12 characters).');
if(prod && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32)) throw Error('Set SESSION_SECRET (at least 32 characters).');
await fs.mkdir(path.join(root,'data'),{recursive:true}); await fs.mkdir(path.join(root,'uploads'),{recursive:true});
const incoming=path.join(root,'data/incoming');await fs.mkdir(incoming,{recursive:true,mode:0o700});
const db=path.join(root,'data/catalog.json');
try{await fs.access(db)}catch{await fs.writeFile(db,JSON.stringify([]))}
const read=async()=>JSON.parse(await fs.readFile(db,'utf8'));
let queue=Promise.resolve();
function mutate(fn){const next=queue.then(async()=>{const items=await read();const result=await fn(items);await fs.writeFile(db+'.tmp',JSON.stringify(items,null,2));await fs.rename(db+'.tmp',db);return result});queue=next.catch(()=>{});return next}
// The owner retired the seeded Éclipse demo. Remove only that seeded record;
// retain all actual products and uploads, including administrator edits.
if ((await read()).some(p=>p.id==='demo'&&p.demo===true)) {
  await mutate(items=>{const i=items.findIndex(p=>p.id==='demo'&&p.demo===true);if(i>=0)items.splice(i,1)});
}
app.disable('x-powered-by'); if(prod)app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'wasm-unsafe-eval'","'sha256-"+crypto.createHash('sha256').update('{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}').digest('base64')+"'"],styleSrc:["'self'"],imgSrc:["'self'","data:","blob:"],connectSrc:["'self'","blob:"],workerSrc:["'self'","blob:"],upgradeInsecureRequests:prod?[]:null}}}));
app.use(express.json({limit:'32kb'}));
// Sessions expire eight hours after login. Avoid background touch writes that
// could recreate a deleted session when a request overlaps logout.
const sessionStore=new (FileStoreFactory(session))({path:path.join(root,'data/sessions'),logFn:()=>{},retries:0});
sessionStore.touch=undefined;
app.use(session({store:sessionStore,secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'strict',secure:prod,maxAge:8*3600000}}));
app.use('/api', (req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&& req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'Origine refusée.'});next()});
const admin=(req,res,next)=>req.session.admin?next():res.status(401).json({error:'Connexion requise.'});
app.post('/api/login',rateLimit({windowMs:15*60000,limit:10}),async(req,res,next)=>{try{const a=crypto.createHash('sha256').update(String(req.body.password||'')).digest(),b=crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest();if(!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Mot de passe incorrect.'});req.session.regenerate(err=>{if(err)return next(err);req.session.admin=true;req.session.save(err=>{if(err)return next(err);res.json({ok:true})})})}catch(e){next(e)}});
app.get('/api/session',(req,res)=>res.json({admin:!!req.session.admin}));
app.post('/api/logout',admin,(req,res,next)=>req.session.destroy(err=>{if(err)return next(err);res.clearCookie('connect.sid',{httpOnly:true,sameSite:'strict',secure:prod});res.json({ok:true})}));
app.get('/api/products',async(req,res)=>res.json((await read()).filter(p=>p.visible)));
app.get('/api/admin/products',admin,async(req,res)=>res.json(await read()));
const upload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,req.uploadDir),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),
 limits:{fileSize:MODEL_MAX_BYTES,files:2,fields:24,parts:28,fieldSize:8192},fileFilter:(req,file,cb)=>{
  const valid=file.fieldname==='image'?/\.(png|jpe?g|webp|heic|heif)$/i.test(file.originalname):file.fieldname==='model'&&/\.glb$/i.test(file.originalname);
  cb(valid?null:Error('Format non pris en charge. Utilisez une photo JPG, PNG, WebP ou HEIC et un modèle GLB.'),valid);
 }}).fields([{name:'image',maxCount:1},{name:'model',maxCount:1}]);
async function receiveUpload(req,res,next){
 try{
  req.uploadDir=await fs.mkdtemp(path.join(incoming,'upload-'));
  const cleanup=()=>fs.rm(req.uploadDir,{recursive:true,force:true}).catch(()=>{});
  if(req.aborted||res.destroyed){await cleanup();return;}
  res.once('close',cleanup);
  upload(req,res,error=>{
   if(!error)return next();
   const message=error.code==='LIMIT_FILE_SIZE'?'Le fichier dépasse la limite autorisée (GLB : 100 Mo, photo : 10 Mo).':error instanceof multer.MulterError?'Trop de fichiers ou de champs dans cet envoi.':error.message;
   res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:message});
  });
 }catch(error){next(error);}
}
app.post('/api/admin/products/:id',admin,receiveUpload,async(req,res)=>{
 const files=Object.values(req.files||{}).flat();
 try{
 let modelMetadata={};
 for(const file of files){
  if(file.fieldname==='model')modelMetadata=await validateModel(file);
  else await validatePhoto(file);
 }
 if(req.aborted||res.destroyed)throw Error('Envoi interrompu.');
 const name=String(req.body.name||'').trim().slice(0,100),brand=String(req.body.brand||'').trim().slice(0,100);if(!name||!brand)throw Error('Nom et marque requis.');
 const scale=Number(req.body.scale??1),offset=Number(req.body.offset??0);if(!Number.isFinite(scale)||scale<0.3||scale>3||!Number.isFinite(offset)||Math.abs(offset)>1)throw Error('Réglage invalide.');
 const hasWidth=req.body.frameWidthMm!==undefined,frameWidthMm=String(req.body.frameWidthMm??'').trim()===''?null:Number(req.body.frameWidthMm);
 if(hasWidth&&frameWidthMm!==null&&(!Number.isFinite(frameWidthMm)||frameWidthMm<80||frameWidthMm>200))throw Error('Largeur extérieure invalide : utilisez des millimètres, entre 80 et 200.');
 const hasRotation=['rotationX','rotationY','rotationZ'].some(k=>req.body[k]!==undefined);
 const rotation=['rotationX','rotationY','rotationZ'].map(k=>Number(req.body[k]??0));
 if(hasRotation&&rotation.some(n=>!Number.isFinite(n)||Math.abs(n)>180))throw Error('Les rotations doivent être comprises entre −180° et 180°.');
 const hasFit=req.body.imageFit!==undefined,imageFit=req.body.imageFit||'contain';
 if(hasFit&&!['contain','cover'].includes(imageFit))throw Error('Cadrage photo invalide.');
 const clientId=req.params.id==='new'&&req.body.productId;
 if(clientId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId))throw Error('Identifiant produit invalide.');
 const moved=[];let result;
 try{
  result=await mutate(async items=>{
   if(req.aborted||res.destroyed)throw Error('Envoi interrompu.');
   let p=items.find(x=>x.id===(clientId||req.params.id));
   if(!p){if(req.params.id!=='new')throw Error('Modèle introuvable.');p={id:clientId||crypto.randomUUID(),demo:false,estimatedDimensions:true};items.push(p);}
   for(const file of files){
    const destination=path.join(root,'uploads',file.filename);await fs.rename(file.path,destination);moved.push(destination);
    if(p[file.fieldname])p[file.fieldname==='model'?'previousModel':'previousImage']=p[file.fieldname];
    p[file.fieldname]='/uploads/'+file.filename;
   }
   Object.assign(p,{name,brand,visible:req.body.visible==='true',scale,offset});
   if(hasWidth){if(frameWidthMm===null)delete p.frameWidthMm;else p.frameWidthMm=frameWidthMm;}
   if(hasRotation)p.modelRotation=rotation;
   if(hasFit)p.imageFit=imageFit;
   if(Object.keys(modelMetadata).length){if(p.sourceSha256)p.previousModelSourceSha256=p.sourceSha256;Object.assign(p,modelMetadata);p.modelSource='Ajout depuis l’administration';}
   return p;
  });
 }catch(error){await Promise.all(moved.map(f=>fs.unlink(f).catch(()=>{})));throw error;}
 res.json(result);
 }catch(error){if(!res.destroyed)res.status(400).json({error:error.message});}
});
app.delete('/api/admin/products/:id',admin,async(req,res)=>{await mutate(items=>{const i=items.findIndex(p=>p.id===req.params.id);if(i>=0)items.splice(i,1)});res.json({ok:true})});
app.use('/uploads',express.static(path.join(root,'uploads'),{setHeaders:res=>res.setHeader('X-Content-Type-Options','nosniff')}));
app.use('/vendor/three',express.static(path.join(root,'node_modules/three')));
app.use('/vendor/vision',express.static(path.join(root,'node_modules/@mediapipe/tasks-vision')));
app.use(express.static(path.join(root,'public')));
app.use((err,req,res,next)=>{console.error(err.message);res.status(500).json({error:'Opération impossible. Vérifiez les fichiers et réessayez.'})});
const server=app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Lunette Caba listening on port '+server.address().port));
server.requestTimeout=10*60*1000;
