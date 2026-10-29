import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {smoothLandmarks, createFaceOccluder, createHeadOccluder, updateRigidOccluders, PoseContinuity} from './tryon-fit.js';
import {estimatePerspectiveFit,trackingAlpha,CAMERA_FOV} from './tryon-perspective.js';
import {FaceLandmarker,FilesetResolver} from '/vendor/vision/vision_bundle.mjs';
import {aborted, waitFor, fetchBuffer, transferMessage} from './tryon-loading.js';
import {CameraFrame} from './tryon-camera.js';
import {prepareKnownMaterials} from './tryon-materials.js';
import {createEarOccluders,updateEarOccluders,prepareKnownTempleFit} from './tryon-ears.js';
import {prepareTempleVisibility,updateTempleVisibility} from './tryon-temple-visibility.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
const $=s=>document.querySelector(s);const products=await fetch('/api/products').then(r=>r.json());
const illustration='<svg viewBox="0 0 600 300" aria-hidden="true"><path d="M90 105 L25 65 M510 105 L575 65"/><path class="lenses" d="M65 110 Q150 65 255 110 L240 195 Q150 240 85 190 Z M345 110 Q450 65 535 110 L515 190 Q450 240 360 195 Z"/><path d="M255 120 Q300 95 345 120"/></svg>';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#count').textContent=products.length+' monture'+(products.length>1?'s':'');
for(const p of products){const card=document.createElement('article');card.className='product';card.innerHTML=`<div class="product-art">${p.image?`<img class="${p.imageFit==='cover'?'product-image--cover':''}" src="${escape(p.image)}" alt="${escape(p.name)}">`:illustration}<span class="badge">${p.demo?'MODÈLE DÉMO':p.estimatedDimensions?'MODÈLE APPROXIMATIF':p.model?'ESSAYAGE 3D':'BIENTÔT EN 3D'}</span></div><p class="brand">${escape(p.brand)}</p><h3>${escape(p.name)}</h3><button ${!p.demo&&!p.model?'disabled':''}>${p.demo||p.model?'Essayer sur mon visage':'Essai bientôt disponible'} <span>↗</span></button>`;card.querySelector('button').onclick=()=>openTry(p);$('#products').append(card)}
if(!products.length)$('#products').textContent='La collection arrive bientôt.';
const dialog=$('#try-dialog'),video=$('#video'),canvas=$('#overlay');
let selected,stream,landmarker,enginePromise,renderer,scene,camera,frame,model;
let loadVersion=0,sessionVersion=0,busy=false,lastTime=-1;
let faceOccluder=null,headOccluder=null,earOccluders=null,canonicalFace=null,previousPose=null,filteredFace=null,lastTrackingTime=0;
let startupController=null,modelController=null,loadingMessage='';
let cameraFrame=null;
let lightingEnvironment=null;
const poseContinuity=new PoseContinuity();
const readyProducts=products.filter(p=>p.demo||p.model);
for(const p of readyProducts)$('#model-select').add(new Option(p.name,p.id));
function phase(message, overlay=false) {
  loadingMessage=message;
  $('#try-status').textContent=message;
  $('#camera-message').hidden=!overlay;
  if(overlay)$('#camera-message').textContent=message;
}
function assertSession(version) {
  if(version!==sessionVersion||!dialog.open)throw aborted();
}
function demoGlasses(){const group=new THREE.Group();const frameMat=new THREE.MeshStandardMaterial({color:0x252a24,roughness:.33});const lensMat=new THREE.MeshStandardMaterial({color:0x263c30,transparent:true,opacity:.83,roughness:.18,metalness:.2});for(const side of [-1,1]){const ring=new THREE.Mesh(new THREE.TorusGeometry(.23,.026,12,64),frameMat);ring.scale.y=.76;ring.position.x=side*.285;group.add(ring);const lens=new THREE.Mesh(new THREE.CircleGeometry(.21,64),lensMat);lens.scale.y=.76;lens.position.set(side*.285,0,-.008);group.add(lens);const arm=new THREE.Mesh(new THREE.BoxGeometry(.025,.035,.52),frameMat);arm.position.set(side*.52,.03,-.25);group.add(arm)}const bridge=new THREE.Mesh(new THREE.BoxGeometry(.14,.03,.035),frameMat);group.add(bridge);return group}
function dispose(obj){obj.traverse(n=>{n.geometry?.dispose();const materials=Array.isArray(n.material)?n.material:n.material?[n.material]:[];for(const m of materials){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}})}
async function setModel(p) {
  selected=p;
  $('#try-name').textContent=p.name;
  $('#model-select').value=p.id;
  $('#model-note').textContent=p.demo
    ? 'Le modèle de démonstration est une illustration, pas une reproduction de vos produits.'
    : p.estimatedDimensions
      ? 'Reconstitution à partir de photos : dimensions, courbure et matériaux estimés. La fidélité au produit réel reste à valider.'
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
    if(p.demo)next=demoGlasses();
    else {
      const buffer=await fetchBuffer(p.model,{
        signal:controller.signal,label:'Modèle 3D',
        onProgress:(bytes,total)=>{if(current())phase(transferMessage('Téléchargement de la monture',bytes,total));}
      });
      if(!current())throw aborted();
      if(buffer.byteLength<12||new DataView(buffer).getUint32(0,true)!==0x46546c67)
        throw new Error('Le fichier de la monture n’est pas un GLB valide.');
      phase('Préparation de la monture et de ses textures…');
      const parsing=new GLTFLoader().parseAsync(buffer,new URL('.',new URL(p.model,location.href)).href);
      let gltf;
      try {
        gltf=await waitFor(parsing,45000,'La préparation de la monture prend trop de temps. Réessayez.',controller.signal);
      } catch(error) {
        // A decoder can finish after cancellation; release that late result.
        parsing.then(value=>dispose(value.scene),()=>{});
        throw error;
      }
      next=gltf.scene;
      const opticalProfile=prepareKnownMaterials(gltf);
      prepareKnownTempleFit(gltf);
      const templeVisibility=prepareTempleVisibility(gltf);
      const box=new THREE.Box3().setFromObject(next),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
      if(!size.x)throw new Error('Le modèle 3D est vide.');
      const fitting=gltf.asset?.extras?.lunetteCaba;
      const anchored=Array.isArray(fitting?.anchor)&&fitting.anchor.length===3&&fitting.anchor.every(Number.isFinite)&&Number.isFinite(fitting.referenceWidth)&&fitting.referenceWidth>0;
      next.position.sub(anchored?new THREE.Vector3(...fitting.anchor):center);
      const wrapper=new THREE.Group();wrapper.add(next);wrapper.scale.setScalar(1/(anchored?fitting.referenceWidth:size.x));
      const normalized=new THREE.Group();normalized.add(wrapper);next=normalized;
      if(opticalProfile)next.userData.opticalProfile=opticalProfile;
      if(templeVisibility)next.userData.templeVisibility=templeVisibility;
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
  loadingMessage='';
  $('#camera-message').hidden=false;
  $('#camera-message').textContent='Activez la caméra pour découvrir votre monture.';
  $('#try-status').textContent='Les images restent sur votre appareil.';
  setModel(p).catch(failed);
}
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
  lightingEnvironment?.dispose();lightingEnvironment=null;
  previousPose=null;
  poseContinuity.reset();
  if(renderer){renderer.clear();renderer.dispose();renderer=null;}
  scene=null;camera=null;lastTime=-1;filteredFace=null;lastTrackingTime=0;loadingMessage='';busy=false;
  $('#start-camera').disabled=false;$('#start-camera').textContent='Activer la caméra';
  $('#model-select').disabled=false;$('#snapshot').disabled=true;
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
dialog.addEventListener('close',stop);
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

$('#start-camera').onclick=async()=>{
  if(busy||stream)return;
  const session=++sessionVersion;
  const controller=new AbortController();startupController=controller;
  busy=true;$('#start-camera').disabled=true;$('#model-select').disabled=true;
  phase('Autorisez l’accès à votre caméra…',true);
  try {
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('HTTPS requis pour accéder à la caméra.');
    const pending=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:960},height:{ideal:720}},audio:false});
    if(session!==sessionVersion||!dialog.open){pending.getTracks().forEach(t=>t.stop());return;}
    stream=pending;video.srcObject=stream;
    await waitFor(video.play(),15000,'La caméra ne fournit pas d’image. Fermez les autres applications caméra puis réessayez.',controller.signal);
    assertSession(session);
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
    const displayRatio=$('#camera-stage').getBoundingClientRect().width/video.videoWidth;
    renderer.setPixelRatio(Math.min(1.5,Math.max(1,displayRatio*(window.devicePixelRatio||1))));
    renderer.setSize(video.videoWidth,video.videoHeight,false);
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
    if(session===sessionVersion){busy=false;$('#start-camera').disabled=!!stream;$('#model-select').disabled=false;}
  }
};
function tick() {
  if (!stream || !renderer) return;
  try {
    if (video.currentTime !== lastTime) {
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
      if(!tracking.held)renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(tick);
  } catch(e) {
    stop();
    $('#try-status').textContent = 'Le suivi a été interrompu. Réactivez la caméra.';
  }
}
$('#snapshot').onclick=()=>{const photo=document.createElement('canvas');photo.width=canvas.width;photo.height=canvas.height;const ctx=photo.getContext('2d');ctx.translate(photo.width,0);ctx.scale(-1,1);ctx.drawImage(canvas,0,0);photo.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mon-essayage.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},'image/png')};
