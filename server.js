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
const root=path.dirname(fileURLToPath(import.meta.url));
const app=express(); const prod=process.env.NODE_ENV==='production';
if(!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length<12) throw Error('Set ADMIN_PASSWORD (at least 12 characters).');
if(prod && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32)) throw Error('Set SESSION_SECRET (at least 32 characters).');
await fs.mkdir(path.join(root,'data'),{recursive:true}); await fs.mkdir(path.join(root,'uploads'),{recursive:true});
const db=path.join(root,'data/catalog.json');
const demo={id:'demo',name:'Éclipse 01',brand:'ATELIER VISION',description:'Une silhouette intemporelle. Découvrez notre monture de démonstration en réalité augmentée.',visible:true,demo:true,scale:1,offset:0};
try{await fs.access(db)}catch{await fs.writeFile(db,JSON.stringify([demo]))}
const read=async()=>JSON.parse(await fs.readFile(db,'utf8'));
let queue=Promise.resolve();
function mutate(fn){const next=queue.then(async()=>{const items=await read();const result=await fn(items);await fs.writeFile(db+'.tmp',JSON.stringify(items,null,2));await fs.rename(db+'.tmp',db);return result});queue=next.catch(()=>{});return next}
app.disable('x-powered-by'); if(prod)app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'wasm-unsafe-eval'","'sha256-"+crypto.createHash('sha256').update('{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}').digest('base64')+"'"],styleSrc:["'self'"],imgSrc:["'self'","data:","blob:"],connectSrc:["'self'"],workerSrc:["'self'","blob:"],upgradeInsecureRequests:prod?[]:null}}}));
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
const upload=multer({storage:multer.diskStorage({destination:path.join(root,'uploads'),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:25*1024*1024,files:2},fileFilter:(req,file,cb)=>cb(null,file.fieldname==='image'?/\.(png|jpe?g|webp)$/i.test(file.originalname):file.fieldname==='model'&&/\.glb$/i.test(file.originalname))}).fields([{name:'image',maxCount:1},{name:'model',maxCount:1}]);
app.post('/api/admin/products/:id',admin,upload,async(req,res)=>{
 const files=Object.values(req.files||{}).flat();
 try{
 for(const f of files){const h=await fs.open(f.path);const bytes=Buffer.alloc(12);await h.read(bytes,0,12,0);await h.close();const ext=path.extname(f.filename);const valid=f.fieldname==='model'?bytes.toString('ascii',0,4)==='glTF'&&bytes.readUInt32LE(4)===2:ext==='.png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):['.jpg','.jpeg'].includes(ext)?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!valid)throw Error('Format de fichier invalide.');}
 const name=String(req.body.name||'').trim().slice(0,100),brand=String(req.body.brand||'').trim().slice(0,100);if(!name||!brand)throw Error('Nom et marque requis.');
 const scale=Number(req.body.scale??1),offset=Number(req.body.offset??0);if(!Number.isFinite(scale)||scale<0.3||scale>3||!Number.isFinite(offset)||Math.abs(offset)>1)throw Error('Réglage invalide.');
 const result=await mutate(items=>{let p=items.find(x=>x.id===req.params.id);if(!p){if(req.params.id!=='new')throw Error('Modèle introuvable.');p={id:crypto.randomUUID(),demo:false};items.push(p)}Object.assign(p,{name,brand,visible:req.body.visible==='true',scale,offset});for(const f of files)p[f.fieldname]='/uploads/'+f.filename;return p});res.json(result);
 }catch(e){await Promise.all(files.map(f=>fs.unlink(f.path).catch(()=>{})));res.status(400).json({error:e.message})}
});
app.delete('/api/admin/products/:id',admin,async(req,res)=>{await mutate(items=>{const i=items.findIndex(p=>p.id===req.params.id);if(i>=0)items.splice(i,1)});res.json({ok:true})});
app.use('/uploads',express.static(path.join(root,'uploads'),{setHeaders:res=>res.setHeader('X-Content-Type-Options','nosniff')}));
app.use('/vendor/three',express.static(path.join(root,'node_modules/three')));
app.use('/vendor/vision',express.static(path.join(root,'node_modules/@mediapipe/tasks-vision')));
app.use(express.static(path.join(root,'public')));
app.use((err,req,res,next)=>{console.error(err.message);res.status(500).json({error:'Opération impossible. Vérifiez les fichiers et réessayez.'})});
const server=app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Atelier Vision listening on port '+server.address().port));
