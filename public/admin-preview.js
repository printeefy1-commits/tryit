import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {createModelLoader} from './model-loader.js';
import {prepareGlasses} from './prepare-glasses.js';
import {fetchBuffer} from './tryon-loading.js';
import {MODEL_MAX_BYTES} from './upload-config.js';

function dispose(model){
  const geometries=new Set(),materials=new Set(),textures=new Set();
  model.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])materials.add(m);});
  for(const m of materials)for(const value of Object.values(m))if(value?.isTexture)textures.add(value);
  for(const resource of [...geometries,...materials,...textures])resource.dispose();
}
export class ModelPreview{
  constructor(canvas){this.canvas=canvas;this.version=0;}
  init(){
    if(this.renderer)return;
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0xedf1f5);
    const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(this.renderer);
    this.environment=pmrem.fromScene(room,.04);this.scene.environment=this.environment.texture;room.dispose();pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1));
    const light=new THREE.DirectionalLight(0xffffff,.8);light.position.set(0,2,5);this.scene.add(light);
    this.camera=new THREE.PerspectiveCamera(35,1,.01,100);this.controls=new OrbitControls(this.camera,this.canvas);
    this.controls.enableDamping=true;this.controls.minDistance=.6;this.controls.maxDistance=5;this.controls.target.set(0,0,-.25);
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(this.canvas.parentElement);this.view('oblique');
  }
  resize(){
    if(!this.renderer)return;
    const {width,height}=this.canvas.getBoundingClientRect();if(!width||!height)return;
    this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();
  }
  view(name){
    if(!this.camera)return;
    this.camera.position.set(...(name==='front'?[0,0,1.8]:[1.2,.55,1.7]));this.controls.target.set(0,0,-.25);this.controls.update();
  }
  play(){
    cancelAnimationFrame(this.frame);
    const render=()=>{if(document.querySelector('#editor').hidden)return;this.controls.update();this.renderer.render(this.scene,this.camera);this.frame=requestAnimationFrame(render);};
    render();
  }
  pause(){cancelAnimationFrame(this.frame);}
  clear(){
    ++this.version;this.controller?.abort();cancelAnimationFrame(this.frame);
    if(this.model){this.scene.remove(this.model);dispose(this.model);this.model=null;}
    this.buffer=null;this.source=null;
    if(this.renderer)this.renderer.clear();
  }
  async load(source,rotation=[0,0,0],onProgress=()=>{}){
    const version=++this.version;this.controller?.abort();const controller=new AbortController();this.controller=controller;
    const current=()=>version===this.version&&!controller.signal.aborted;
    let gltf,model;
    try{
      let buffer=this.source===source?this.buffer:null;
      if(!buffer)buffer=source instanceof File?await source.arrayBuffer():await fetchBuffer(source,{signal:controller.signal,maxBytes:MODEL_MAX_BYTES,onProgress});
      if(!current())return false;
      const view=new DataView(buffer);
      if(buffer.byteLength<20||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength)throw Error('Ce fichier n’est pas un GLB valide.');
      const length=view.getUint32(12,true);
      if(length>8*1024*1024||length+20>buffer.byteLength)throw Error('Structure GLB invalide.');
      const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
      if(doc.buffers?.some(b=>b.uri)||doc.images?.some(i=>i.uri))throw Error('Exportez un GLB autonome avec ses textures intégrées.');
      if(doc.extensionsUsed?.includes('KHR_texture_basisu'))throw Error('Utilisez des textures PNG, JPEG ou WebP, sans compression KTX2.');
      this.init();this.resize();await new Promise(requestAnimationFrame);
      gltf=await createModelLoader().parseAsync(buffer,location.href);
      if(!current()){dispose(gltf.scene);return false;}
      const hash=crypto.subtle?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(b=>b.toString(16).padStart(2,'0')).join(''):undefined;
      if(!current()){dispose(gltf.scene);return false;}
      model=prepareGlasses(gltf,{modelRotation:rotation,sourceSha256:hash});
      if(this.model){this.scene.remove(this.model);dispose(this.model);}
      this.model=model;this.scene.add(model);this.source=source;this.buffer=buffer;this.view('oblique');this.play();return true;
    }catch(error){if(model)dispose(model);else if(gltf)dispose(gltf.scene);if(current())throw error;return false;}
  }
}
