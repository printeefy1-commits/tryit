import {productPhotos,displayProductImage} from './product-photos.js';
import {requestCamera} from './camera-request.js';
const $=s=>document.querySelector(s);const products=(await fetch('/api/products').then(r=>r.json())).filter(p=>!(p.id==='demo'&&p.demo));
const cameraIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 1.5-2h5L16 5h4v15H4V5Z"/><circle cx="12" cy="12" r="4"/></svg>';
const arrowIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#count').textContent=String(products.length).padStart(2,'0')+' monture'+(products.length>1?'s':'');
for(const [index,p] of products.entries()){
  const card=document.createElement('article');card.className='product';const photos=productPhotos(p);
  const description=p.id==='head-12028-col400'?'Noir profond · Verres gris':p.id==='head-12028-models-v2'?'Bleu nuit · Verres bleus':'Votre prochain point de vue.';
  card.innerHTML=`<div class="product-art">${p.image?`<img class="${p.imageFit==='cover'?'product-image--cover':''}" alt="${escape(p.brand+' '+p.name)}" width="1300" height="1000" loading="lazy">`:'<div class="product-placeholder">Photo à venir</div>'}<span class="product-number">${String(index+1).padStart(2,'0')}</span><span class="badge">${cameraIcon}${p.model?'ESSAYAGE VIRTUEL':'BIENTÔT EN ESSAI'}</span></div><div class="product-info"><div class="product-heading"><div><p class="brand">${escape(p.brand)}</p><h3>${escape(p.name)}</h3></div><span class="product-icon" aria-hidden="true">${arrowIcon}</span></div><p class="product-description">${description}</p><button class="product-try" ${!p.model?'disabled':''}>${p.model?'Essayer sur mon visage':'Essai bientôt disponible'} ${arrowIcon}</button></div>`;
  if(p.image)displayProductImage(card.querySelector('.product-art>img'),p.image);
  card.querySelector('.product-try').onclick=()=>openTry(p);
  if(photos.length>1){
    const gallery=document.createElement('div');gallery.className='product-photo-choices';gallery.setAttribute('role','group');gallery.setAttribute('aria-label','Photos de '+p.brand+' '+p.name);
    for(const [photoIndex,src] of photos.entries()){
      const choice=document.createElement('button');choice.type='button';choice.setAttribute('aria-label','Voir la photo '+(photoIndex+1)+' de '+p.brand+' '+p.name);choice.setAttribute('aria-pressed',String(photoIndex===0));
      const img=document.createElement('img');displayProductImage(img,src,128);img.alt='';img.loading='lazy';choice.append(img);
      choice.onclick=()=>{const main=card.querySelector('.product-art>img');displayProductImage(main,src);main.alt=p.brand+' '+p.name+' · photo '+(photoIndex+1);for(const button of gallery.children)button.setAttribute('aria-pressed',String(button===choice));};gallery.append(choice);
    }
    card.querySelector('.product-art').append(gallery);
  }
  $('#products').append(card);
}
if(!products.length){const empty=document.createElement('p');empty.className='empty-collection';empty.textContent='La collection arrive bientôt.';$('#products').append(empty);}
const featured=products.find(p=>p.id==='head-12028-models-v2'&&p.image)||products.find(p=>p.image);
if(featured){displayProductImage($('#hero-photo'),featured.image);$('#hero-photo').alt=featured.brand+' '+featured.name;$('#hero-photo').hidden=false;$('#hero-product-name').textContent=featured.brand+' '+featured.name;}
const dialog=$('#try-dialog'),mobileTry=matchMedia('(max-width:750px), (hover:none) and (pointer:coarse)');
let runtimeModule,runtime,opening=0,acquired;
function closeTry(){
  ++opening;acquired?.getTracks().forEach(track=>track.stop());acquired=null;
  runtime?.stop();document.body.classList.remove('try-open');
}
function openTry(product){
  dialog.showModal();document.body.classList.add('try-open');
  dialog.classList.toggle('mobile-try',mobileTry.matches);
  $('#try-name').textContent=product.name;$('#try-brand').textContent=product.brand+' / ESSAYAGE EN DIRECT';
  $('#start-camera').hidden=true;$('#snapshot').disabled=true;
  $('#camera-message').hidden=false;$('#camera-message').textContent='Autorisez l’accès à votre caméra…';
  $('#try-status').textContent='Préparation de l’essayage…';
  const version=++opening,current=()=>version===opening&&dialog.open;
  // Ask within the original tap, before downloading the optional 3D engine.
  // A late permission result must not leave the camera running after closing.
  const pending=requestCamera().then(stream=>{
    if(!current()){stream.getTracks().forEach(track=>track.stop());throw new DOMException('Opération annulée.','AbortError');}
    acquired=stream;return stream;
  });
  let handedOff=false;
  const fail=(error,cameraFailure=false)=>{
    if(!current())return;
    ++opening;acquired?.getTracks().forEach(track=>track.stop());acquired=null;
    runtime?.stop();$('#camera-message').hidden=false;
    $('#camera-message').textContent=error.name==='NotAllowedError'?'Autorisez la caméra dans votre navigateur pour continuer.':error.name==='NotFoundError'?'Aucune caméra détectée.':cameraFailure?'La caméra ne démarre pas. Fermez les autres applications caméra puis réessayez.':'Le chargement de l’essayage a échoué. Réessayez ou actualisez la page.';
    $('#try-status').textContent=$('#camera-message').textContent;$('#start-camera').hidden=false;$('#start-camera').textContent=cameraFailure?'Réessayer':'Actualiser la page';
    $('#start-camera').onclick=cameraFailure?()=>{dialog.close();openTry(product);}:()=>location.reload();
  };
  pending.catch(error=>{if(!handedOff)fail(error,true);});
  if(!runtimeModule)runtimeModule=import('./tryon.js').catch(error=>{runtimeModule=null;throw error;});
  runtimeModule.then(module=>{
    if(!current())return;
    runtime??=module.createTryOn(products);handedOff=true;runtime.open(product,pending);
  }).catch(error=>fail(error));
}
$('#close-try').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>{if(!dialog.open)closeTry();});
window.addEventListener('pagehide',closeTry);
