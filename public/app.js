import * as THREE from 'three';
import {createModelLoader} from './model-loader.js';
import {prepareGlasses} from './prepare-glasses.js';
import {MODEL_MAX_BYTES} from './upload-config.js';
import {productPhotos} from './product-photos.js';
import {smoothLandmarks, createFaceOccluder, createHeadOccluder, updateRigidOccluders, PoseContinuity} from './tryon-fit.js';
import {estimatePerspectiveFit,trackingAlpha,CAMERA_FOV} from './tryon-perspective.js';
import {FaceLandmarker,FilesetResolver} from '/vendor/vision/vision_bundle.mjs';
import {aborted, waitFor, fetchBuffer, transferMessage} from './tryon-loading.js';
import {CameraFrame} from './tryon-camera.js';
import {createEarOccluders,updateEarOccluders} from './tryon-ears.js';
import {updateTempleVisibility} from './tryon-temple-visibility.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
const $=s=>document.querySelector(s);const products=(await fetch('/api/products').then(r=>r.json())).filter(p=>!(p.id==='demo'&&p.demo));
const cameraIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 1.5-2h5L16 5h4v15H4V5Z"/><circle cx="12" cy="12" r="4"/></svg>';
const arrowIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#count').textContent=String(products.length).padStart(2,'0')+' monture'+(products.length>1?'s':'');
for(const [index,p] of products.entries()){
  const card=document.createElement('article');card.className='product';const photos=productPhotos(p);
  const description=p.id==='head-12028-col400'?'Noir profond · Verres gris':p.id==='head-12028-models-v2'?'Bleu nuit · Verres bleus':'Votre prochain point de vue.';
  card.innerHTML=`<div class="product-art">${p.image?`<img class="${p.imageFit==='cover'?'product-image--cover':''}" src="${escape(p.image)}" alt="${escape(p.brand+' '+p.name)}" width="1300" height="1000" loading="lazy">`:'<div class="product-placeholder">Photo à venir</div>'}<span class="product-number">${String(index+1).padStart(2,'0')}</span><span class="badge">${cameraIcon}${p.model?'ESSAYAGE VIRTUEL':'BIENTÔT EN ESSAI'}</span></div><div class="product-info"><div class="product-heading"><div><p class="brand">${escape(p.brand)}</p><h3>${escape(p.name)}</h3></div><span class="product-icon" aria-hidden="true">${arrowIcon}</span></div><p class="product-description">${description}</p><button class="product-try" ${!p.model?'disabled':''}>${p.model?'Essayer sur mon visage':'Essai bientôt disponible'} ${arrowIcon}</button></div>`;
  card.querySelector('.product-try').onclick=()=>openTry(p);
  if(photos.length>1){
    const gallery=document.createElement('div');gallery.className='product-photo-choices';gallery.setAttribute('role','group');gallery.setAttribute('aria-label','Photos de '+p.brand+' '+p.name);
    for(const [photoIndex,src] of photos.entries()){
      const choice=document.createElement('button');choice.type='button';choice.setAttribute('aria-label','Voir la photo '+(photoIndex+1)+' de '+p.brand+' '+p.name);choice.setAttribute('aria-pressed',String(photoIndex===0));
      const img=document.createElement('img');img.src=src;img.alt='';img.loading='lazy';choice.append(img);
      choice.onclick=()=>{const main=card.querySelector('.product-art>img');main.src=src;main.alt=p.brand+' '+p.name+' · photo '+(photoIndex+1);for(const button of gallery.children)button.setAttribute('aria-pressed',String(button===choice));};gallery.append(choice);
    }
    card.querySelector('.product-art').append(gallery);
  }
  $('#products').append(card);
}
if(!products.length){const empty=document.createElement('p');empty.className='empty-collection';empty.textContent='La collection arrive bientôt.';$('#products').append(empty);}
const featured=products.find(p=>p.id==='head-12028-models-v2'&&p.image)||products.find(p=>p.image);
if(featured){$('#hero-photo').src=featured.image;$('#hero-photo').alt=featured.brand+' '+featured.name;$('#hero-photo').hidden=false;$('#hero-product-name').textContent=featured.brand+' '+featured.name;}
const dialog=$('#try-dialog'),video=$('#video'),canvas=$('#overlay');
const backdrop=$('#camera-backdrop'),backdropContext=backdrop.getContext('2d',{alpha:false});
const mobileTry=matchMedia('(max-width:750px), (hover:none) and (pointer:coarse)');
let selected,stream,landmarker,enginePromise,renderer,scene,camera,frame,model;
let loadVersion=0,sessionVersion=0,busy=false,lastTime=-1;
let faceOccluder=null,headOccluder=null,earOccluders=null,canonicalFace=null,previousPose=null,filteredFace=null,lastTrackingTime=0;
let startupController=null,modelController=null,loadingMessage='';
let cameraFrame=null;
let lightingEnvironment=null;
const poseContinuity=new PoseContinuity();
const readyProducts=products.filter(p=>p.model);
for(const p of readyProducts){
  $('#model-select').add(new Option(p.brand+' '+p.name,p.id));
  const choice=document.createElement('button');choice.type='button';choice.className='model-choice';choice.dataset.modelId=p.id;
  choice.setAttribute('aria-label','Essayer '+p.brand+' '+p.name);choice.setAttribute('aria-pressed','false');
  choice.innerHTML=`<span class="choice-photo">${p.image?`<img src="${escape(p.image)}" alt="" width="64" height="64">`:cameraIcon}</span><span class="choice-name">${escape(p.name)}</span>`;
  choice.onclick=()=>{if(selected?.id!==p.id)setModel(p).catch(failed);};$('#model-choices').append(choice);
}
function setModelChoicesDisabled(disabled){
  $('#model-select').disabled=disabled;
  for(const choice of $('#model-choices').children)choice.disabled=disabled;
}
function phase(message, overlay=false) {
  loadingMessage=message;
  $('#try-status').textContent=message;
  $('#camera-message').hidden=!overlay;
  if(overlay)$('#camera-message').textContent=message;
}
function assertSession(version) {
  if(version!==sessionVersion||!dialog.open)throw aborted();
}
function dispose(obj){obj.traverse(n=>{n.geometry?.dispose();const materials=Array.isArray(n.material)?n.material:n.material?[n.material]:[];for(const m of materials){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}})}
// Read-only console diagnostics for checking an uploaded file on a remote
// device. No camera frames, landmarks, credentials or private URLs are exposed.
window.tryonDiagnostics=()=>({productId:selected?.id||null,sourceSha256:selected?.sourceSha256||null,
  fitting:model?.userData.fitting||null,templeGroups:model?.userData.templeVisibility?.arms.length||0});

async function setModel(p) {
  selected=p;
  $('#try-name').textContent=p.name;
  $('#try-brand').textContent=p.brand+' / ESSAYAGE EN DIRECT';
  $('#model-select').value=p.id;
  for(const choice of $('#model-choices').children)choice.setAttribute('aria-pressed',String(choice.dataset.modelId===p.id));
  $('#model-note').textContent=p.estimatedDimensions
      ? 'Les dimensions et l’ajustement de cet aperçu restent estimés. La fidélité au produit réel reste à valider.'
      : 'Aperçu du modèle 3D fourni pour cette monture. Le rendu dépend de votre appareil et de l’éclairage.';
  $('#snapshot').disabled=true;
  const version=++loadVersion,session=sessionVersion;
  modelController?.abort();
  const controller=new AbortController();
  modelController=controller;
  if(model){scene?.remove(model);dispose(model);model=null;}
  if(!scene)return;
  let next;
  const current=()=>version===loadVersion&&session===sessionVersion&&dialog.open;
  try {
    phase('Chargement de la monture…');
    {
      const buffer=await fetchBuffer(p.model,{
        signal:controller.signal,label:'Modèle 3D',maxBytes:MODEL_MAX_BYTES,
        onProgress:(bytes,total)=>{if(current())phase(transferMessage('Téléchargement de la monture',bytes,total));}
      });
      if(!current())throw aborted();
      if(buffer.byteLength<12||new DataView(buffer).getUint32(0,true)!==0x46546c67)
        throw new Error('Le fichier de la monture n’est pas un GLB valide.');
      phase('Préparation de la monture et de ses textures…');
      const parsing=createModelLoader().parseAsync(buffer,new URL('.',new URL(p.model,location.href)).href);
      let gltf;
      try {
        gltf=await waitFor(parsing,45000,'La préparation de la monture prend trop de temps. Réessayez.',controller.signal);
      } catch(error) {
        // A decoder can finish after cancellation; release that late result.
        parsing.then(value=>dispose(value.scene),()=>{});
        throw error;
      }
      next=gltf.scene;
      next=prepareGlasses(gltf,p);
    }
    if(!current())throw aborted();
    model=next;model.visible=false;scene.add(model);
    loadingMessage='';
    $('#camera-message').hidden=true;
  } catch(error) {
    if(next&&next!==model)dispose(next);
    if(!current()||controller.signal.aborted)throw aborted();
    throw error;
  }
}

function openTry(p) {
  dialog.showModal();
  document.body.classList.add('try-open');
  applyTryMode();
  loadingMessage='';
  $('#camera-message').hidden=false;
  $('#camera-message').textContent='Activez la caméra pour découvrir votre monture.';
  $('#try-status').textContent='Les images restent sur votre appareil.';
  setModel(p).catch(failed);
  // Start within the original tap, including on Safari. The browser still
  // owns its permission prompt; closing invalidates a pending request.
  startCamera();
}
function applyTryMode(){
  dialog.classList.toggle('mobile-try',mobileTry.matches);
  $('#try-info').open=false;
  $('#start-camera').hidden=!!stream||busy;
}
mobileTry.addEventListener('change',()=>{if(dialog.open){applyTryMode();resizeCameraDisplay();}});
$('#model-select').onchange=()=>setModel(readyProducts.find(p=>p.id===$('#model-select').value)).catch(failed);

function stop() {
  ++sessionVersion;++loadVersion;
  startupController?.abort();startupController=null;
  modelController?.abort();modelController=null;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;
  if(model){scene?.remove(model);dispose(model);model=null;}
  if(faceOccluder){dispose(faceOccluder);faceOccluder=null;}
  if(headOccluder){dispose(headOccluder);headOccluder=null;}
  if(earOccluders){dispose(earOccluders);earOccluders=null;}
  cameraFrame?.dispose();cameraFrame=null;
  backdrop.width=backdrop.height=1;
  lightingEnvironment?.dispose();lightingEnvironment=null;
  previousPose=null;
  poseContinuity.reset();
  if(renderer){renderer.clear();renderer.dispose();renderer=null;}
  scene=null;camera=null;lastTime=-1;filteredFace=null;lastTrackingTime=0;loadingMessage='';busy=false;
  $('#start-camera').disabled=false;$('#start-camera').textContent='Activer la caméra';
  $('#start-camera').hidden=false;
  setModelChoicesDisabled(false);$('#snapshot').disabled=true;
}
function failed(error) {
  if(error.name==='AbortError')return;
  console.error('Virtual try-on:',error.message);
  stop();
  const message=error.name==='NotAllowedError'
    ? 'Autorisez la caméra dans votre navigateur pour continuer.'
    : error.name==='NotFoundError'?'Aucune caméra détectée.':error.message;
  phase(message,true);
  $('#start-camera').textContent='Réessayer';
}
$('#close-try').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>{if(!dialog.open){stop();document.body.classList.remove('try-open');}});
window.addEventListener('pagehide',stop);

async function getFaceEngine(signal,session) {
  if(landmarker)return landmarker;
  // Reuse an in-flight initializer across close/retry to avoid duplicate WASM heaps.
  if(!enginePromise) {
    enginePromise=(async()=>{
      const buffer=await fetchBuffer('/models/face_landmarker.task',{
        label:'Suivi du visage',maxBytes:10*1024*1024,
        onProgress:(bytes,total)=>{if(session===sessionVersion&&dialog.open)phase(transferMessage('Téléchargement du suivi du visage',bytes,total),true);}
      });
      if(session===sessionVersion&&dialog.open)phase('Initialisation du suivi du visage…',true);
      const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
      const detector=await FaceLandmarker.createFromOptions(files,{
        baseOptions:{modelAssetBuffer:new Uint8Array(buffer),delegate:'CPU'},runningMode:'VIDEO',numFaces:1,outputFacialTransformationMatrixes:true,
        minFaceDetectionConfidence:.4,minFacePresenceConfidence:.35,minTrackingConfidence:.35
      });
      landmarker=detector;
      return detector;
    })().finally(()=>{enginePromise=null;});
  }
  return waitFor(enginePromise,60000,'Le suivi du visage ne démarre pas. Vérifiez votre connexion puis réessayez.',signal);
}

async function startCamera(){
  if(busy||stream)return;
  const session=++sessionVersion;
  const controller=new AbortController();startupController=controller;
  busy=true;$('#start-camera').disabled=true;setModelChoicesDisabled(true);
  $('#start-camera').hidden=true;
  phase('Autorisez l’accès à votre caméra…',true);
  try {
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('HTTPS requis pour accéder à la caméra.');
    const mobile=dialog.classList.contains('mobile-try'),portrait=innerHeight>=innerWidth;
    const pending=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',
      width:{ideal:mobile?(portrait?720:1280):960},height:{ideal:mobile?(portrait?1280:720):720},
      ...(mobile?{resizeMode:{ideal:'none'}}:{aspectRatio:{ideal:4/3}})},audio:false});
    if(session!==sessionVersion||!dialog.open){pending.getTracks().forEach(t=>t.stop());return;}
    stream=pending;
    if(mobile){
      // Prefer the camera's widest supported view. Many front cameras do not
      // expose zoom; a failed optional adjustment must not stop the preview.
      try {
        const track=pending.getVideoTracks()[0],zoom=track.getCapabilities?.().zoom;
        if(zoom&&Number.isFinite(zoom.min)){
          const current=track.getConstraints?.()||{};
          await track.applyConstraints({...current,advanced:[...(current.advanced||[]),{zoom:zoom.min}]});
        }
      }catch{/* Keep the uncropped native stream when zoom is unavailable. */}
      assertSession(session);
    }
    video.srcObject=stream;
    await waitFor(video.play(),15000,'La caméra ne fournit pas d’image. Fermez les autres applications caméra puis réessayez.',controller.signal);
    assertSession(session);
    updateCameraBackdrop(video);
    phase('Chargement du suivi du visage…',true);
    await getFaceEngine(controller.signal,session);
    assertSession(session);
    phase('Préparation du suivi…',true);
    const topologyBuffer=await fetchBuffer('/models/face-topology.json',{signal:controller.signal,label:'Suivi du visage',maxBytes:1024*1024});
    const topology=JSON.parse(new TextDecoder().decode(topologyBuffer));
    const canonicalBuffer=await fetchBuffer('/models/canonical-face.json',{signal:controller.signal,label:'Géométrie du visage',maxBytes:1024*1024});
    canonicalFace=JSON.parse(new TextDecoder().decode(canonicalBuffer)).vertices;
    assertSession(session);
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    $('#camera-stage').style.aspectRatio=canvas.width+'/'+canvas.height;
    phase('Initialisation de l’affichage 3D…',true);
    renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,preserveDrawingBuffer:true});
    // Sharper model edges on a large/high-DPI preview, without increasing the
    // camera frame sent to the face detector or unbounded mobile GPU work.
    resizeCameraDisplay();
    scene=new THREE.Scene();const aspect=canvas.width/canvas.height;
    const room=new RoomEnvironment(),generator=new THREE.PMREMGenerator(renderer);
    lightingEnvironment=generator.fromScene(room,.04);scene.environment=lightingEnvironment.texture;
    room.dispose();generator.dispose();
    cameraFrame=new CameraFrame(video.videoWidth,video.videoHeight);
    scene.background=cameraFrame.texture;
    camera=new THREE.PerspectiveCamera(CAMERA_FOV,aspect,.1,500);
    faceOccluder=createFaceOccluder(topology.triangles);scene.add(faceOccluder);
    headOccluder=createHeadOccluder();scene.add(headOccluder);
    earOccluders=createEarOccluders();scene.add(earOccluders);
    scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1));
    const light=new THREE.DirectionalLight(0xffffff,.8);light.position.set(0,2,5);scene.add(light);
    // Tracking no longer waits for a large GLB to download and decode.
    tick();
    await setModel(selected);
    assertSession(session);
    $('#start-camera').textContent='Caméra active';
  } catch(error) {
    if(session===sessionVersion)failed(error);
  } finally {
    if(session===sessionVersion){busy=false;$('#start-camera').disabled=!!stream;setModelChoicesDisabled(false);}
  }
}
$('#start-camera').onclick=startCamera;

function resizeCameraDisplay(){
  if(!renderer||!video.videoWidth||!video.videoHeight)return;
  const stage=$('#camera-stage').getBoundingClientRect();
  const ratios=[stage.width/video.videoWidth,stage.height/video.videoHeight];
  const displayRatio=Math.min(...ratios);
  renderer.setPixelRatio(Math.min(1.5,Math.max(1,displayRatio*(window.devicePixelRatio||1))));
  renderer.setSize(video.videoWidth,video.videoHeight,false);
  if(camera){camera.aspect=canvas.width/canvas.height;camera.updateProjectionMatrix();}
}
window.addEventListener('resize',resizeCameraDisplay);
window.visualViewport?.addEventListener('resize',resizeCameraDisplay);
function updateCameraBackdrop(source){
  if(!dialog.open||!backdropContext)return;
  const width=source.videoWidth||source.width,height=source.videoHeight||source.height;
  if(!width||!height)return;
  // A small copy is enough for a blurred surround. Keep it independent of
  // detector resolution and use the exact captured frame after inference.
  const scale=Math.min(1,320/Math.max(width,height));
  const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
  if(backdrop.width!==w||backdrop.height!==h){backdrop.width=w;backdrop.height=h;}
  backdropContext.drawImage(source,0,0,w,h);
}
function tick() {
  if (!stream || !renderer) return;
  if(video.readyState<2||!video.videoWidth||!video.videoHeight){frame=requestAnimationFrame(tick);return;}
  try {
    if (video.currentTime !== lastTime) {
      if(cameraFrame.canvas.width!==video.videoWidth||cameraFrame.canvas.height!==video.videoHeight){
        cameraFrame.dispose();cameraFrame=new CameraFrame(video.videoWidth,video.videoHeight);scene.background=cameraFrame.texture;
        resizeCameraDisplay();filteredFace=null;previousPose=null;lastTrackingTime=0;poseContinuity.reset();
      }
      lastTime = video.currentTime;
      const now = performance.now();
      const image=cameraFrame.capture(video);
      const result = landmarker.detectForVideo(image, now);
      const face = result.faceLandmarks?.[0];
      let fitted = false;
      let fit=null;
      if (face) {
        const dt = lastTrackingTime ? Math.min((now - lastTrackingTime) / 1000, 0.2) : 1;
        const aspect = canvas.width / canvas.height;
        const alpha=trackingAlpha(filteredFace,face,dt,aspect);
        filteredFace=smoothLandmarks(filteredFace,face,alpha);
        lastTrackingTime = now;
        const matrix=result.facialTransformationMatrixes?.[0];
        fit=canonicalFace&&matrix?estimatePerspectiveFit(face,aspect,matrix,canonicalFace,previousPose,alpha,selected.scale,selected.offset):null;
        if(fit)previousPose=fit;
      }
      const tracking=poseContinuity.update(fit,now);
      if (model && tracking.fit) {
        model.visible = true;
        model.position.copy(tracking.fit.position);
        model.quaternion.copy(tracking.fit.quaternion);
        const frameWidth=selected.frameWidthMm?selected.frameWidthMm/10:model.userData.opticalProfile?.frameWidthCm??14;
        model.scale.setScalar(tracking.fit.width*frameWidth/14);
        if(!tracking.held){
          updateRigidOccluders(faceOccluder,headOccluder,filteredFace,canvas.width/canvas.height,fit);
          updateEarOccluders(earOccluders,fit);
          updateTempleVisibility(model,[faceOccluder,headOccluder,earOccluders]);
        }
        fitted = true;
      }
      if(!tracking.fit) {
        filteredFace = null;
        previousPose=null;
        lastTrackingTime = 0;
      }
      if (!fitted) {
        if (model) model.visible = false;
        if (faceOccluder) faceOccluder.visible = false;
        if (headOccluder) headOccluder.visible = false;
        if (earOccluders) earOccluders.visible = false;
      }
      $('#snapshot').disabled = !fitted||tracking.held;
      if(!loadingMessage)$('#try-status').textContent = fitted
        ? tracking.held ? 'Suivi momentanément incertain…' : 'Visage détecté · Essayez une autre monture ou prenez une photo.'
        : 'Visage insuffisamment visible · Regardez légèrement vers la caméra pour reprendre le suivi.';
      // A retained pose belongs to the previous image. Keep that complete
      // composite briefly; never paint old glasses over a newer moving face.
      if(!tracking.held){renderer.render(scene, camera);updateCameraBackdrop(image);}
    }
    frame = requestAnimationFrame(tick);
  } catch(e) {
    stop();
    $('#start-camera').textContent='Réessayer';
    $('#try-status').textContent = 'Le suivi a été interrompu. Réactivez la caméra.';
  }
}
$('#snapshot').onclick=()=>{
  const photo=document.createElement('canvas'),width=canvas.width,height=canvas.height;
  photo.width=Math.max(1,Math.round(width));photo.height=Math.max(1,Math.round(height));
  const ctx=photo.getContext('2d');ctx.translate(photo.width,0);ctx.scale(-1,1);
  ctx.drawImage(canvas,(canvas.width-width)/2,(canvas.height-height)/2,width,height,0,0,photo.width,photo.height);
  photo.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mon-essayage.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},'image/png');
};
