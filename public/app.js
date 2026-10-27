import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {estimateFit, smoothLandmarks, createFaceOccluder, updateFaceOccluder} from './tryon-fit.js';
import {FaceLandmarker,FilesetResolver} from '/vendor/vision/vision_bundle.mjs';
const $=s=>document.querySelector(s);const products=await fetch('/api/products').then(r=>r.json());
const illustration='<svg viewBox="0 0 600 300" aria-hidden="true"><path d="M90 105 L25 65 M510 105 L575 65"/><path class="lenses" d="M65 110 Q150 65 255 110 L240 195 Q150 240 85 190 Z M345 110 Q450 65 535 110 L515 190 Q450 240 360 195 Z"/><path d="M255 120 Q300 95 345 120"/></svg>';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#count').textContent=products.length+' monture'+(products.length>1?'s':'');
for(const p of products){const card=document.createElement('article');card.className='product';card.innerHTML=`<div class="product-art">${p.image?`<img class="${p.imageFit==='cover'?'product-image--cover':''}" src="${escape(p.image)}" alt="${escape(p.name)}">`:illustration}<span class="badge">${p.demo?'MODÈLE DÉMO':p.estimatedDimensions?'MODÈLE APPROXIMATIF':p.model?'ESSAYAGE 3D':'BIENTÔT EN 3D'}</span></div><p class="brand">${escape(p.brand)}</p><h3>${escape(p.name)}</h3><button ${!p.demo&&!p.model?'disabled':''}>${p.demo||p.model?'Essayer sur mon visage':'Essai bientôt disponible'} <span>↗</span></button>`;card.querySelector('button').onclick=()=>openTry(p);$('#products').append(card)}
if(!products.length)$('#products').textContent='La collection arrive bientôt.';
const dialog=$('#try-dialog'),video=$('#video'),canvas=$('#overlay');let selected,stream,landmarker,renderer,scene,camera,frame,model,loadVersion=0,busy=false,lastTime=-1,faceOccluder=null,filteredFace=null,lastTrackingTime=0;
let topologyPromise;
const readyProducts=products.filter(p=>p.demo||p.model);for(const p of readyProducts){const o=new Option(p.name,p.id);$('#model-select').add(o)}
function demoGlasses(){const group=new THREE.Group();const frameMat=new THREE.MeshStandardMaterial({color:0x252a24,roughness:.33});const lensMat=new THREE.MeshStandardMaterial({color:0x263c30,transparent:true,opacity:.83,roughness:.18,metalness:.2});for(const side of [-1,1]){const ring=new THREE.Mesh(new THREE.TorusGeometry(.23,.026,12,64),frameMat);ring.scale.y=.76;ring.position.x=side*.285;group.add(ring);const lens=new THREE.Mesh(new THREE.CircleGeometry(.21,64),lensMat);lens.scale.y=.76;lens.position.set(side*.285,0,-.008);group.add(lens);const arm=new THREE.Mesh(new THREE.BoxGeometry(.025,.035,.52),frameMat);arm.position.set(side*.52,.03,-.25);group.add(arm)}const bridge=new THREE.Mesh(new THREE.BoxGeometry(.14,.03,.035),frameMat);group.add(bridge);return group}
function dispose(obj){obj.traverse(n=>{n.geometry?.dispose();const materials=Array.isArray(n.material)?n.material:n.material?[n.material]:[];for(const m of materials){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}})}
async function setModel(p){selected=p;$('#try-name').textContent=p.name;$('#model-select').value=p.id;$('#model-note').textContent=p.demo?'Le modèle de démonstration est une illustration, pas une reproduction de vos produits.':p.estimatedDimensions?'Reconstitution à partir de photos : dimensions, courbure et matériaux estimés. La fidélité au produit réel reste à valider.':'Aperçu du modèle 3D fourni pour cette monture. Le rendu dépend de votre appareil et de l’éclairage.';$('#snapshot').disabled=true;const version=++loadVersion;if(model){scene?.remove(model);dispose(model);model=null}if(!scene)return;try{let next;if(p.demo)next=demoGlasses();else{const gltf=await new GLTFLoader().loadAsync(p.model);next=gltf.scene;const box=new THREE.Box3().setFromObject(next),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());if(!size.x)throw Error('Modèle vide');const fitting=gltf.asset?.extras?.lunetteCaba;const anchored=Array.isArray(fitting?.anchor)&&fitting.anchor.length===3&&fitting.anchor.every(Number.isFinite)&&Number.isFinite(fitting.referenceWidth)&&fitting.referenceWidth>0;next.position.sub(anchored?new THREE.Vector3(...fitting.anchor):center);const wrapper=new THREE.Group();wrapper.add(next);wrapper.scale.setScalar(1/(anchored?fitting.referenceWidth:size.x));const normalized=new THREE.Group();normalized.add(wrapper);next=normalized}if(version!==loadVersion){dispose(next);return}model=next;model.visible=false;scene.add(model)}catch(e){$('#try-status').textContent='Impossible de charger le modèle 3D. Vérifiez son fichier.'}}
function openTry(p){dialog.showModal();$('#camera-message').hidden=false;$('#camera-message').textContent='Activez la caméra pour découvrir votre monture.';$('#try-status').textContent='Les images restent sur votre appareil.';setModel(p)}
$('#model-select').onchange=e=>setModel(readyProducts.find(p=>p.id===e.target.value));
function stop(){cancelAnimationFrame(frame);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;$('#start-camera').disabled=false;$('#snapshot').disabled=true;loadVersion++;if(model){scene?.remove(model);dispose(model);model=null}if(faceOccluder){dispose(faceOccluder);faceOccluder=null}renderer?.dispose();renderer=null;scene=null;camera=null;lastTime=-1;filteredFace=null;lastTrackingTime=0}
$('#close-try').onclick=()=>dialog.close();dialog.addEventListener('close',stop);window.addEventListener('pagehide',stop);
$('#start-camera').onclick=async()=>{if(busy)return;busy=true;$('#start-camera').disabled=true;$('#try-status').textContent='Chargement du suivi du visage…';try{if(!navigator.mediaDevices?.getUserMedia)throw Error('HTTPS requis pour accéder à la caméra.');const pending=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:960},height:{ideal:720}},audio:false});if(!dialog.open){pending.getTracks().forEach(t=>t.stop());return}stream=pending;video.srcObject=stream;await video.play();if(!landmarker){const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');landmarker=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'/models/face_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numFaces:1})}if(!dialog.open)return;canvas.width=video.videoWidth;canvas.height=video.videoHeight;$('#camera-stage').style.aspectRatio=canvas.width+'/'+canvas.height;topologyPromise??=fetch('/models/face-topology.json').then(r=>{if(!r.ok)throw Error('Masque de profondeur indisponible');return r.json()}).catch(e=>{topologyPromise=null;throw e});const topology=await topologyPromise;if(!dialog.open)return;renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(canvas.width,canvas.height,false);scene=new THREE.Scene();const aspect=canvas.width/canvas.height;camera=new THREE.OrthographicCamera(-aspect,aspect,1,-1,.01,100);camera.position.z=5;faceOccluder=createFaceOccluder(topology.triangles);scene.add(faceOccluder);scene.add(new THREE.HemisphereLight(0xffffff,0x777777,3));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(0,2,5);scene.add(light);await setModel(selected);$('#camera-message').hidden=true;tick()}catch(e){stop();$('#try-status').textContent=e.name==='NotAllowedError'?'Autorisez la caméra dans votre navigateur pour continuer.':e.name==='NotFoundError'?'Aucune caméra détectée.':`Impossible de démarrer : ${e.message}` }finally{busy=false;$('#start-camera').disabled=!!stream}};
function tick() {
  if (!stream || !renderer) return;
  try {
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      const now = performance.now();
      const result = landmarker.detectForVideo(video, now);
      const face = result.faceLandmarks?.[0];
      let fitted = false;
      if (face) {
        const dt = lastTrackingTime ? Math.min((now - lastTrackingTime) / 1000, 0.2) : 1;
        filteredFace = smoothLandmarks(filteredFace, face, 1 - Math.exp(-dt / 0.055));
        lastTrackingTime = now;
        const aspect = canvas.width / canvas.height;
        const fit = estimateFit(filteredFace, aspect, selected.scale, selected.offset);
        if (model && fit) {
          model.visible = true;
          model.position.copy(fit.position);
          model.quaternion.copy(fit.quaternion);
          model.scale.setScalar(fit.width);
          updateFaceOccluder(faceOccluder, filteredFace, aspect);
          fitted = true;
        }
      } else {
        filteredFace = null;
        lastTrackingTime = 0;
      }
      if (!fitted) {
        if (model) model.visible = false;
        if (faceOccluder) faceOccluder.visible = false;
      }
      $('#snapshot').disabled = !fitted;
      $('#try-status').textContent = fitted
        ? 'Visage détecté · Essayez une autre monture ou prenez une photo.'
        : 'Placez votre visage dans le cadre.';
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(tick);
  } catch(e) {
    stop();
    $('#try-status').textContent = 'Le suivi a été interrompu. Réactivez la caméra.';
  }
}
$('#snapshot').onclick=()=>{const photo=document.createElement('canvas');photo.width=canvas.width;photo.height=canvas.height;const ctx=photo.getContext('2d');ctx.translate(photo.width,0);ctx.scale(-1,1);ctx.drawImage(video,0,0);ctx.drawImage(canvas,0,0);photo.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mon-essayage.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},'image/png')};
