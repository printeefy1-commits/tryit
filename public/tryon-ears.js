import * as THREE from 'three';
import {knownModelProfile} from './tryon-model-profiles.js';

// MediaPipe's face mesh has no ear landmarks. These are deliberately labelled
// template dimensions in canonical cm, not detected ear edges or measurements.
export const EAR_TEMPLATE=Object.freeze({x:6.9,y:1.95,z:-7.3,radiusX:.65,radiusY:2.45,radiusZ:1.6});
export const TEMPLE_SUPPORT=Object.freeze({lengthScale:1,hingeZ:4,innerX:4.5,
  lowerEdgeY:EAR_TEMPLATE.y+EAR_TEMPLATE.radiusY+.02,contactX:EAR_TEMPLATE.x+.15,contactZ:EAR_TEMPLATE.z,overlapCm:.2});

export function isTempleRegion(x,z){
  // Keep the inner front rim/bridge out of the rear-arm controller. Only the
  // inward hook far behind the lenses needs the wider eligibility boundary.
  return z<TEMPLE_SUPPORT.hingeZ&&(Math.abs(x)>5.3||(Math.abs(x)>TEMPLE_SUPPORT.innerX&&z< -2));
}

export function createEarOccluders() {
  const ears=new THREE.Group();ears.name='estimated-ear-depth-masks';ears.visible=false;
  // In addition to pixel depth, terminate the continuous arm at the estimated
  // upper-ear support. A high shaft can otherwise run above the ellipsoid and
  // its hook reappear on top of the ear, even though the ear mask is working.
  ears.userData.templeSupport={z:TEMPLE_SUPPORT.contactZ-TEMPLE_SUPPORT.overlapCm,
    x:EAR_TEMPLATE.x,radiusX:EAR_TEMPLATE.radiusX+1,minY:EAR_TEMPLATE.y,
    maxY:TEMPLE_SUPPORT.lowerEdgeY+1.5};
  for(const side of [-1,1]){
    const geometry=new THREE.SphereGeometry(1,24,20);
    geometry.scale(EAR_TEMPLATE.radiusX,EAR_TEMPLATE.radiusY,EAR_TEMPLATE.radiusZ);
    geometry.translate(side*EAR_TEMPLATE.x,EAR_TEMPLATE.y,EAR_TEMPLATE.z);
    const material=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:THREE.DoubleSide});
    const ear=new THREE.Mesh(geometry,material);ear.name=side<0?'estimated-left-ear':'estimated-right-ear';
    ear.renderOrder=-12;ear.frustumCulled=false;ears.add(ear);
  }
  return ears;
}

export function updateEarOccluders(ears,fit) {
  ears.position.copy(fit.translation);ears.quaternion.copy(fit.quaternion);
  ears.scale.setScalar(fit.metricScale);ears.visible=true;
}

// Lens protection must follow materials, not an assumed slot in an uploaded GLB.
export function isLensMaterial(material){
  return !!material&&(material.transmission>0||(material.transparent&&material.opacity<1)
    ||/(?:^|[ _-])(lens(?:es)?|verres?)(?:$|[ _-])/i.test(material.name||''));
}

function protectedLensVertices(mesh,reviewed){
  const geometry=mesh.geometry,flags=new Uint8Array(geometry.attributes.position.count);
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
  const count=geometry.index?.count??flags.length;
  const groups=Array.isArray(mesh.material)&&geometry.groups.length?geometry.groups:[{start:0,count,materialIndex:0}];
  for(const group of groups)if((reviewed&&Array.isArray(mesh.material)&&group.materialIndex===1)||isLensMaterial(materials[group.materialIndex])){
    for(let j=group.start;j<Math.min(count,group.start+group.count);j++)flags[geometry.index?geometry.index.getX(j):j]=1;
  }
  return flags;
}

// Lift each temple as one rigid part around its hinge. A single rotation is
// used for every rear vertex, including the original hook: no envelopes or
// vertex-dependent bending may change its shape. Optional +20% length is a
// single axial scale before rotation; thickness and the front stay unchanged.
export function prepareKnownTempleFit(gltf,geometryProfile=null,{templeLengthScale=1}={}) {
  const profile=geometryProfile||gltf.asset?.extras?.lunetteCaba,reviewed=!geometryProfile;
  if((reviewed&&!knownModelProfile(gltf))||gltf.scene.userData.templeFitApplied)return null;
  if(!Array.isArray(profile?.anchor)||profile.anchor.length!==3||!profile.anchor.every(Number.isFinite)
    ||!Number.isFinite(profile.referenceWidth)||profile.referenceWidth<=0)return null;
  const anchor=new THREE.Vector3(...profile.anchor),point=new THREE.Vector3(),offset=new THREE.Vector3(0,2.625,5.5);
  const lengthScale=templeLengthScale===1.2?1.2:1;
  const sourcePerCm=profile.referenceWidth/14,records=[],sides=[{bins:new Map(),count:0,minZ:Infinity},{bins:new Map(),count:0,minZ:Infinity}];
  let unsupported=false;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh||!mesh.geometry.attributes.position)return;
    if(mesh.isSkinnedMesh||Object.keys(mesh.geometry.morphAttributes).length){unsupported=true;return;}
    const positions=mesh.geometry.attributes.position,lenses=protectedLensVertices(mesh,reviewed);
    const flags=new Uint8Array(positions.count),canonical=new Float64Array(positions.count*3);
    for(let i=0;i<positions.count;i++)if(!lenses[i]){
      point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).divideScalar(sourcePerCm).add(offset);
      if(!isTempleRegion(point.x,point.z))continue;
      const side=point.x<0?0:1,data=sides[side],bin=Math.floor(point.z*4);
      flags[i]=side+1;point.toArray(canonical,i*3);data.count++;data.minZ=Math.min(data.minZ,point.z);
      if(!data.bins.has(bin))data.bins.set(bin,new THREE.Box3());data.bins.get(bin).expandByPoint(point);
    }
    records.push({mesh,flags,canonical});
  });
  if(unsupported||sides.some(side=>side.count<12||side.minZ> -2)){
    gltf.scene.userData.templeFitSkipped=unsupported?'animated-geometry':'rear-arms-not-found';return null;
  }
  const hinges=sides.map((side,index)=>{
    const bins=[...side.bins.values()],root=new THREE.Box3();
    const frontZ=Math.max(...bins.map(box=>box.max.z));
    for(const box of bins)if(box.max.z>=frontZ-.4)root.union(box);
    const pivot=root.getCenter(new THREE.Vector3());pivot.z=TEMPLE_SUPPORT.hingeZ;
    // Aim the original lower shaft (ahead of the hook) at the upper ear.
    // Sampling supplies one angle; it never supplies per-vertex offsets.
    const targetZ=Math.max(TEMPLE_SUPPORT.hingeZ+(TEMPLE_SUPPORT.contactZ+.5-TEMPLE_SUPPORT.hingeZ)/lengthScale,side.minZ+(frontZ-side.minZ)*.18);
    const section=bins.reduce((best,box)=>Math.abs(box.getCenter(new THREE.Vector3()).z-targetZ)<Math.abs(best.getCenter(new THREE.Vector3()).z-targetZ)?box:best);
    const reference=section.getCenter(new THREE.Vector3());reference.y=section.min.y;
    reference.z=pivot.z+(reference.z-pivot.z)*lengthScale;
    const dy=reference.y-pivot.y,dz=reference.z-pivot.z,radius=Math.hypot(dy,dz);
    const desired=THREE.MathUtils.clamp((TEMPLE_SUPPORT.lowerEdgeY-pivot.y)/radius,-1,1);
    const angle=THREE.MathUtils.clamp(Math.asin(desired)-Math.atan2(dy,-dz),0,THREE.MathUtils.degToRad(25));
    const pitch=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),angle);
    const aimed=reference.clone().sub(pivot).applyQuaternion(pitch),sideSign=index===0?-1:1;
    // Opening the hinge toward the ear also keeps an inward-authored shaft
    // outside the temple. This is a second rigid hinge angle, never a splay
    // offset that grows or shrinks independently along the shaft.
    const horizontal=Math.hypot(aimed.x,aimed.z),desiredX=sideSign*TEMPLE_SUPPORT.contactX-pivot.x;
    const yaw=THREE.MathUtils.clamp(Math.atan2(aimed.x,-aimed.z)-Math.asin(THREE.MathUtils.clamp(desiredX/horizontal,-1,1)),-.2,.2);
    const quaternion=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw).multiply(pitch);
    const rotation=new THREE.Matrix4().makeTranslation(...pivot.toArray()).multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternion))
      .multiply(new THREE.Matrix4().makeScale(1,1,lengthScale)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
    return {side:sideSign,pivot,angle,yaw,quaternion,rotation,reference};
  });
  const toCanonical=new THREE.Matrix4().makeTranslation(...offset.toArray())
    .multiply(new THREE.Matrix4().makeScale(1/sourcePerCm,1/sourcePerCm,1/sourcePerCm))
    .multiply(new THREE.Matrix4().makeTranslation(-anchor.x,-anchor.y,-anchor.z));
  const fromCanonical=toCanonical.clone().invert();
  let movedVertices=0,maxLiftCm=0,maxExtensionCm=0,maxSplayCm=0;
  for(const {mesh,flags,canonical} of records){
    if(!flags.some(Boolean))continue;
    const original=mesh.geometry,geometry=original.clone(),positions=geometry.attributes.position;
    const transforms=hinges.map(hinge=>mesh.matrixWorld.clone().invert().multiply(fromCanonical).multiply(hinge.rotation).multiply(toCanonical).multiply(mesh.matrixWorld));
    const normals=transforms.map(matrix=>new THREE.Matrix3().getNormalMatrix(matrix)),direction=new THREE.Vector3();
    for(let i=0;i<positions.count;i++)if(flags[i]){
      const side=flags[i]-1,before=point.fromArray(canonical,i*3),after=before.clone().applyMatrix4(hinges[side].rotation);
      maxLiftCm=Math.max(maxLiftCm,after.y-before.y);maxExtensionCm=Math.max(maxExtensionCm,before.z-after.z);maxSplayCm=Math.max(maxSplayCm,Math.sign(before.x)*(after.x-before.x));
      point.fromBufferAttribute(original.attributes.position,i).applyMatrix4(transforms[side]);positions.setXYZ(i,point.x,point.y,point.z);
      if(geometry.attributes.normal){direction.fromBufferAttribute(original.attributes.normal,i).applyNormalMatrix(normals[side]);geometry.attributes.normal.setXYZ(i,direction.x,direction.y,direction.z);}
      if(geometry.attributes.tangent){direction.fromBufferAttribute(original.attributes.tangent,i).transformDirection(transforms[side]);geometry.attributes.tangent.setXYZW(i,direction.x,direction.y,direction.z,original.attributes.tangent.getW(i));}
      movedVertices++;
    }
    positions.needsUpdate=true;
    if(geometry.attributes.normal)geometry.attributes.normal.needsUpdate=true;
    if(geometry.attributes.tangent)geometry.attributes.tangent.needsUpdate=true;
    geometry.computeBoundingBox();geometry.computeBoundingSphere();mesh.geometry=geometry;original.dispose();
  }
  gltf.scene.userData.templeFitApplied=true;
  gltf.scene.userData.templeFitProfile={anchor:profile.anchor,referenceWidth:profile.referenceWidth,reviewed};
  const adjustment={estimated:true,method:reviewed?'reviewed-source':'geometry',adjustment:'hinge-rotation',lengthScale,
    supportLowerEdgeY:TEMPLE_SUPPORT.lowerEdgeY,maxLiftCm,maxSplayCm,maxExtensionCm,movedVertices,
    hinges:hinges.map(({side,pivot,angle,yaw,quaternion,reference})=>({side,pivot:pivot.toArray(),angleDegrees:THREE.MathUtils.radToDeg(angle),openingDegrees:THREE.MathUtils.radToDeg(yaw),quaternion:quaternion.toArray(),reference:reference.toArray()}))};
  gltf.scene.userData.templeFit=adjustment;return adjustment;
}
