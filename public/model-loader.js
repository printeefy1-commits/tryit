import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';

const draco=new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/').setWorkerLimit(2);
export function createModelLoader(){return new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);}
window.addEventListener('pagehide',()=>draco.dispose());
