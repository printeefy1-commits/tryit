import {MODEL_MAX_BYTES,MODEL_OPTIMIZATION_VERSION} from './upload-config.js';
import {PhotoGallery} from './admin-gallery.js';
const $=s=>document.querySelector(s),form=$('#editor');
let items=[],editing='new',currentProduct=null,uploading=false,preview,previewPromise,previewVersion=0,previewLoading=false,previewError=false;
const gallery=new PhotoGallery(()=>updateSave(),message=>feedback(message));
const size=bytes=>bytes?`${(bytes/1024/1024).toFixed(1)} Mo`:'';
function feedback(text,state='error'){const node=$('#feedback');node.textContent=text;node.dataset.state=state;node.hidden=!text;}
function authentication(admin){$('#login').hidden=admin;$('#dashboard').hidden=!admin;if(!admin)preview?.pause();else if(!form.hidden&&preview?.model)preview.play();}
function httpError(status){return status===413?'Envoi refusé. Vérifiez les tailles (GLB : 100 Mo ; photo : 10 Mo) et la limite de téléversement du serveur.':status===401?'Votre session a expiré. Reconnectez-vous pour continuer.':status===408||status===504?'L’envoi a expiré. Vérifiez votre connexion et réessayez.':'L’enregistrement a échoué. Réessayez.';}
function parseResponse(text,status){let data;try{data=JSON.parse(text);}catch{throw Error(httpError(status));}if(status<200||status>=300)throw Object.assign(Error(data.error||httpError(status)),{status});return data;}
async function api(url,options={}){const r=await fetch(url,options);try{return parseResponse(await r.text(),r.status);}catch(error){if(r.status===401&&url!=='/api/login')authentication(false);throw error;}}
function drawList(){
  const query=$('#product-search').value.trim().toLocaleLowerCase(),visible=items.filter(p=>(p.brand+' '+p.name).toLocaleLowerCase().includes(query));
  $('#list').replaceChildren();
  for(const p of visible){
    const row=document.createElement('div');row.className='row admin-product';
    const photo=document.createElement('div');photo.className='admin-product-photo';
    if(p.image){const img=document.createElement('img');img.src=p.image;img.alt='';photo.append(img);}else photo.textContent='LC';
    const info=document.createElement('div');info.className='admin-product-info';
    const brand=document.createElement('span');brand.className='brand';brand.textContent=p.brand;
    const title=document.createElement('strong');title.textContent=p.name;
    const badges=document.createElement('div');badges.className='admin-product-badges';
    for(const [text,kind] of [[p.visible?'Visible':'Masqué',p.visible?'live':'hidden'],[p.modelProcessing?'Préparation 3D…':p.model?'3D prêt':'Sans 3D',p.model?'ready':'missing']]){const badge=document.createElement('span');badge.className='admin-badge admin-badge--'+kind;badge.textContent=text;badges.append(badge);}
    if(p.modelBytes){const bytes=document.createElement('small');bytes.textContent=p.modelOptimization?`${size(p.modelBytes)} · original ${size(p.modelOriginalBytes)}`:size(p.modelBytes);badges.append(bytes);}
    if(p.modelOptimization){const saved=document.createElement('small');saved.textContent=p.modelOptimization.status==='optimized'?`−${Math.round(100*(1-p.modelBytes/p.modelOriginalBytes))} % · optimisé`:'Déjà compact';badges.append(saved);}
    info.append(brand,title,badges);
    const actions=document.createElement('div');actions.className='admin-row-actions';
    const edit=document.createElement('button');edit.textContent='Modifier';edit.disabled=uploading||p.modelProcessing;edit.onclick=()=>open(p);
    const del=document.createElement('button');del.textContent='Supprimer';del.className='delete-product';del.disabled=uploading||p.modelProcessing;del.onclick=async()=>{
      if(uploading||!confirm('Supprimer cette monture ?'))return;
      try{await api('/api/admin/products/'+encodeURIComponent(p.id),{method:'DELETE'});if(editing===p.id)closeEditor();feedback('Monture supprimée.','success');await refresh();}catch(error){feedback(error.message);}
    };
    if(p.model&&p.modelOptimization?.version!==MODEL_OPTIMIZATION_VERSION){
      const optimize=document.createElement('button');optimize.textContent=p.modelProcessing?'Préparation…':'Alléger le GLB';optimize.disabled=uploading||p.modelProcessing;
      optimize.onclick=async()=>{if(uploading)return;setUploading(true);feedback('Préparation du modèle pour les connexions lentes…','success');try{await api('/api/admin/products/'+encodeURIComponent(p.id)+'/optimize',{method:'POST'});await refresh();feedback('Modèle préparé. L’original est conservé.','success');}catch(error){feedback(error.message);}finally{setUploading(false);}};
      actions.append(optimize);
    }
    actions.append(edit,del);row.append(photo,info,actions);$('#list').append(row);
  }
  if(!visible.length){const empty=document.createElement('div');empty.className='admin-empty';empty.textContent=items.length?'Aucune monture ne correspond à votre recherche.':'Votre collection commence ici. Ajoutez votre première monture.';$('#list').append(empty);}
}
async function refresh(){
  const state=await api('/api/session');authentication(state.admin);if(!state.admin)return;
  items=await api('/api/admin/products');$('#stat-total').textContent=items.length;$('#stat-visible').textContent=items.filter(p=>p.visible).length;$('#stat-models').textContent=items.filter(p=>p.model).length;drawList();
}
function updateSave(){ $('#save-product').disabled=uploading||gallery.blocked||!!form.elements.model.files[0]&&(previewLoading||previewError); }
function setUploading(value){uploading=value;$('#editor-fields').disabled=value;$('#new').disabled=value;$('#logout').disabled=value;drawList();updateSave();}
async function getPreview(){if(!previewPromise)previewPromise=import('./admin-preview.js').then(({ModelPreview})=>{preview=new ModelPreview($('#model-preview'));return preview;});return previewPromise;}
async function renderModel(){
  const version=++previewVersion,source=form.elements.model.files[0]||currentProduct?.model;
  if(!source){preview?.clear();previewLoading=false;previewError=false;$('#preview-message').hidden=false;$('#preview-message').textContent='Ajoutez un GLB pour le voir sous tous les angles.';$('#preview-status').textContent='Faites glisser pour tourner le modèle.';updateSave();return;}
  const rotation=['rotationX','rotationY','rotationZ'].map(name=>Number(form.elements[name].value||0));
  if(rotation.some(n=>!Number.isFinite(n)||Math.abs(n)>180)){feedback('Les rotations doivent être comprises entre −180° et 180°.');return;}
  previewLoading=true;previewError=false;updateSave();$('#preview-message').hidden=false;$('#preview-message').textContent='Préparation de l’aperçu 3D…';$('#preview-status').textContent='Chargement du modèle…';
  try{
    const viewer=await getPreview();if(version!==previewVersion)return;
    const loaded=await viewer.load(source,rotation,(got,total)=>{if(version===previewVersion)$('#preview-status').textContent=total?`Chargement : ${Math.round(got/total*100)} %`:'Chargement…';});
    if(version!==previewVersion||!loaded)return;
    $('#preview-message').hidden=true;$('#preview-status').textContent='Modèle prêt · faites glisser pour le tourner.';
  }catch(error){if(version!==previewVersion)return;previewError=true;$('#preview-message').hidden=false;$('#preview-message').textContent=error.message;$('#preview-status').textContent='Aperçu indisponible. Choisissez un GLB valide.';}
  finally{if(version===previewVersion){previewLoading=false;updateSave();}}
}
function updatePhotoFit(){ $('#photo-preview').classList.toggle('photo-cover',form.elements.imageFit.value==='cover'); }
function open(product){
  if(uploading)return;
  ++previewVersion;preview?.clear();currentProduct=product||null;editing=product?.id||'new';form.reset();
  for(const key of ['name','brand','scale','offset','frameWidthMm'])form.elements[key].value=product?.[key]??({scale:1,offset:0}[key]??'');
  for(const [index,key] of ['rotationX','rotationY','rotationZ'].entries())form.elements[key].value=product?.modelRotation?.[index]??0;
  form.elements.productId.value=product?.id||crypto.randomUUID();form.elements.visible.checked=product?.visible??true;form.elements.imageFit.value=product?.imageFit||'contain';
  $('#editor-title').textContent=product?'Modifier la monture':'Nouvelle monture';$('#image-file-meta').textContent=product?.image?'Photo actuelle conservée tant que vous n’en choisissez pas une autre.':'Aucune photo sélectionnée.';
  $('#model-file-meta').textContent=product?.model?(product.modelFileName||'Modèle 3D actuel')+(product.modelBytes?' · '+size(product.modelBytes):'')+(product.modelOriginalBytes?' · original '+size(product.modelOriginalBytes):''):'Aucun modèle sélectionné.';
  const original=$('#model-original');original.hidden=!product?.modelOriginal;if(product?.modelOriginal){original.href=product.modelOriginal;original.download=product.modelFileName||'original.glb';}else original.removeAttribute('href');
  $('#upload-state').hidden=true;form.hidden=false;gallery.reset(product);updatePhotoFit();renderModel();form.scrollIntoView({behavior:'smooth',block:'start'});form.elements.name.focus({preventScroll:true});
}
function closeEditor(){++previewVersion;preview?.clear();previewLoading=false;previewError=false;form.hidden=true;currentProduct=null;gallery.reset();form.reset();}
function selectFile(input){
  if(input.name==='image'){gallery.add([...input.files]);input.value='';return;}
  const file=input.files[0];
  if(file&&(file.size>MODEL_MAX_BYTES||!/\.glb$/i.test(file.name))){feedback('Choisissez un GLB de 100 Mo maximum.');input.value='';$('#model-file-meta').textContent='Sélection refusée · choisissez un autre fichier.';renderModel();return;}
  feedback('');$('#model-file-meta').textContent=file?file.name+' · '+size(file.size):'Le modèle actuel sera conservé.';renderModel();
}
function sendProduct(data){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/admin/products/'+encodeURIComponent(editing));xhr.timeout=10*60*1000;
    xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;const percent=Math.min(100,Math.round(event.loaded/event.total*100));$('#upload-progress').value=percent;$('#upload-percent').textContent=percent+' %';$('#upload-label').textContent=percent===100?(data.has('model')?'Optimisation du modèle 3D…':'Vérification et enregistrement…'):'Envoi de vos fichiers…';$('#upload-detail').textContent=percent===100?(data.has('model')?'Le serveur prépare une version plus légère et conserve votre original. Cette étape peut prendre quelques minutes.':'Le serveur prépare les photos. Gardez cette page ouverte.'):`${size(event.loaded)} / ${size(event.total)} · Gardez cette page ouverte.`;};
    xhr.onload=()=>{try{resolve(parseResponse(xhr.responseText,xhr.status));}catch(error){if(xhr.status===401)authentication(false);reject(error);}};
    xhr.onerror=()=>reject(Error('Connexion interrompue. Vérifiez votre connexion puis réessayez.'));xhr.onabort=()=>reject(Error('Envoi interrompu. Vérifiez la liste des produits avant de réessayer.'));xhr.ontimeout=()=>reject(Error('L’envoi a expiré. Vérifiez la liste des produits avant de réessayer.'));xhr.send(data);
  });
}
$('#login').onsubmit=async event=>{event.preventDefault();$('#login-submit').disabled=true;try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})});$('#password').value='';feedback('');await refresh();}catch(error){feedback(error.message);}finally{$('#login-submit').disabled=false;}};
$('#new').onclick=()=>open();$('#cancel').onclick=()=>{if(!uploading)closeEditor();};$('#logout').onclick=async()=>{if(uploading)return;try{await api('/api/logout',{method:'POST'});closeEditor();await refresh();}catch(error){feedback(error.message);}};
$('#product-search').oninput=drawList;
for(const name of ['image','model'])form.elements[name].onchange=()=>selectFile(form.elements[name]);
form.elements.imageFit.onchange=updatePhotoFit;
for(const zone of document.querySelectorAll('.upload-drop')){
  zone.ondragover=event=>{event.preventDefault();if(!uploading)zone.classList.add('drag-over');};zone.ondragleave=()=>zone.classList.remove('drag-over');
  zone.ondrop=event=>{event.preventDefault();zone.classList.remove('drag-over');if(uploading||!event.dataTransfer.files.length)return;const transfer=new DataTransfer();for(const file of [...event.dataTransfer.files].slice(0,zone.dataset.file==='image'?undefined:1))transfer.items.add(file);const input=form.elements[zone.dataset.file];input.files=transfer.files;selectFile(input);};
}
$('#apply-orientation').onclick=renderModel;$('#preview-front').onclick=()=>preview?.view('front');$('#preview-oblique').onclick=()=>preview?.view('oblique');
form.onsubmit=async event=>{
  event.preventDefault();if(uploading||gallery.blocked||form.elements.model.files[0]&&(previewLoading||previewError))return;
  const data=new FormData(form);data.set('visible',form.elements.visible.checked?'true':'false');if(!data.get('model')?.size)data.delete('model');gallery.appendTo(data);
  setUploading(true);feedback('');$('#upload-state').hidden=false;$('#upload-progress').value=0;$('#upload-percent').textContent='0 %';$('#upload-label').textContent='Envoi en cours…';$('#upload-detail').textContent='Gardez cette page ouverte jusqu’à la confirmation.';
  try{await sendProduct(data);closeEditor();feedback('Monture enregistrée.','success');try{await refresh();}catch{feedback('Monture enregistrée. Actualisez la page pour mettre la liste à jour.','success');}}
  catch(error){feedback(error.message);$('#upload-label').textContent='Enregistrement non confirmé';$('#upload-detail').textContent=error.message;}
  finally{setUploading(false);}
};
window.addEventListener('beforeunload',event=>{if(uploading){event.preventDefault();event.returnValue='';}});
refresh().catch(error=>feedback(error.message));

setInterval(()=>{if(!uploading&&!$('#dashboard').hidden&&items.some(p=>p.modelProcessing))refresh().catch(error=>feedback(error.message));},5000);
