import * as THREE from 'three';
import {prepareKnownMaterials} from './tryon-materials.js';
import {prepareKnownTempleFit} from './tryon-ears.js';
import {prepareTempleVisibility} from './tryon-temple-visibility.js';

// New uploads use a frontal fitting anchor, rather than the centre of the
// complete object (which lies halfway down the arms). Embedded reviewed
// profiles keep their exact anchors. The same preparation powers admin preview
// and the live try-on, including any orientation chosen by the administrator.
export function prepareGlasses(gltf,product={}){
  const angles=product.modelRotation||[0,0,0],rotated=angles.some(n=>n!==0);
  let profile=gltf.asset?.extras?.lunetteCaba;
  if(!profile&&!rotated){
    const known={
      '046f50c9b51e6d12d0956db2d60a4b0566c6d0455e5f2a374d8af939b198e0bf':{anchor:[0,.135,.19],referenceWidth:.8858},
      'a013cbe08e711629e2a47a62560ca87b625dca8a0f20bdd4c6eae92f67c51514':{anchor:[0,.135,.19],referenceWidth:.8858},
      '20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055':{anchor:[-.00085,.14,.2114],referenceWidth:.9078}
    }[product.sourceSha256];
    if(known){profile={...known,sourceSha256:product.sourceSha256};gltf.asset={...gltf.asset,extras:{...gltf.asset?.extras,lunetteCaba:profile}};}
  }
  const opticalProfile=!rotated?prepareKnownMaterials(gltf):null;
  if(!rotated)prepareKnownTempleFit(gltf);
  const templeVisibility=!rotated?prepareTempleVisibility(gltf):null;
  const oriented=new THREE.Group();oriented.add(gltf.scene);
  oriented.rotation.set(...angles.map(THREE.MathUtils.degToRad));oriented.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(oriented),size=box.getSize(new THREE.Vector3());
  if(!Number.isFinite(size.x)||size.x<=0)throw Error('Le modèle 3D est vide.');
  const anchored=!rotated&&Array.isArray(profile?.anchor)&&profile.anchor.length===3&&profile.anchor.every(Number.isFinite)&&Number.isFinite(profile.referenceWidth)&&profile.referenceWidth>0;
  let anchor,referenceWidth;
  if(anchored){anchor=new THREE.Vector3(...profile.anchor);referenceWidth=profile.referenceWidth;}
  else{
    const front=new THREE.Box3(),point=new THREE.Vector3(),threshold=box.max.z-size.x*.16;
    oriented.traverse(mesh=>{
      if(!mesh.isMesh)return;
      const positions=mesh.geometry.attributes.position;
      for(let i=0;i<positions.count;i++){
        point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld);
        if(point.z>=threshold)front.expandByPoint(point);
      }
    });
    if(front.isEmpty()||front.max.x-front.min.x<size.x*.4)front.copy(box);
    referenceWidth=front.max.x-front.min.x;anchor=front.getCenter(new THREE.Vector3());
    anchor.z=box.max.z-referenceWidth*.025;
  }
  const shifted=new THREE.Group();shifted.add(oriented);shifted.position.copy(anchor).negate();
  const wrapper=new THREE.Group();wrapper.add(shifted);wrapper.scale.setScalar(1/referenceWidth);
  const model=new THREE.Group();model.add(wrapper);
  if(opticalProfile)model.userData.opticalProfile=opticalProfile;
  if(templeVisibility)model.userData.templeVisibility=templeVisibility;
  model.userData.fitting={anchor:anchor.toArray(),referenceWidth,estimated:!anchored};
  return model;
}
