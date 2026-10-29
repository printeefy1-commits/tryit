import * as THREE from 'three';

const HEAD_SOURCE_SHA='20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055';

// MediaPipe's face mesh has no ear landmarks. These are deliberately labelled
// template dimensions in canonical cm, not detected ear edges or measurements.
export const EAR_TEMPLATE=Object.freeze({x:6.9,y:1.95,z:-5.8,radiusX:.65,radiusY:2.45,radiusZ:1.6});

export function createEarOccluders() {
  const ears=new THREE.Group();ears.name='estimated-ear-depth-masks';ears.visible=false;
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

// The known generated HEAD mesh bends down too early, ending across the ear
// opening. Lift only its rear temples smoothly toward the estimated upper rim.
// The lens/bridge/hinge positions, UVs, material assignments and source GLB stay
// intact. This is an aesthetic fitting adjustment, not a new measured product.
export function prepareKnownTempleFit(gltf) {
  const profile=gltf.asset?.extras?.lunetteCaba;
  if(profile?.sourceSha256!==HEAD_SOURCE_SHA||gltf.scene.userData.templeFitApplied)return null;
  if(!Array.isArray(profile.anchor)||profile.anchor.length!==3||!profile.anchor.every(Number.isFinite)
    ||!Number.isFinite(profile.referenceWidth)||profile.referenceWidth<=0)return null;
  const anchor=new THREE.Vector3(...profile.anchor),point=new THREE.Vector3();
  const sourcePerCm=profile.referenceWidth/14;
  let movedVertices=0;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const original=mesh.geometry,geometry=original.clone(),positions=geometry.attributes.position;
    const movedFlags=new Uint8Array(positions.count);
    const lensVertices=new Uint8Array(positions.count);
    // In production the known optical preparation precedes this adjustment.
    // Keep every lens boundary vertex intact, even when shared with its rim.
    if(Array.isArray(mesh.material)&&geometry.index){
      for(const group of geometry.groups)if(group.materialIndex===1){
        for(let j=group.start;j<group.start+group.count;j++)lensVertices[geometry.index.getX(j)]=1;
      }
    }
    const inverse=mesh.matrixWorld.clone().invert();
    let moved=0;
    for(let i=0;i<positions.count;i++){
      point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld);
      const x=(point.x-anchor.x)/sourcePerCm,z=(point.z-anchor.z)/sourcePerCm+5.5;
      if(lensVertices[i]||Math.abs(x)<=5.3||z>=4)continue;
      // Two gradual sections keep the shaft nearly level; a single large
      // lift across the entire arm makes an artificial hump before the ear.
      const lift=.55*THREE.MathUtils.smoothstep(4-z,0,7)
        +.8*THREE.MathUtils.smoothstep(-2.5-z,0,3);
      if(lift<1e-6)continue;
      // The generated arms also fold inward behind a wide front. A bounded
      // rear splay opens them around the head, so mild turns do not hide the
      // whole near shaft behind the front rim. Hinges/lenses stay unchanged.
      const splay=THREE.MathUtils.smoothstep(4-z,0,5.5);
      point.x+=Math.sign(x)*splay*sourcePerCm;
      point.y+=lift*sourcePerCm;point.applyMatrix4(inverse);
      positions.setXYZ(i,point.x,point.y,point.z);movedFlags[i]=1;moved++;
    }
    if(!moved){geometry.dispose();return;}
    positions.needsUpdate=true;geometry.computeVertexNormals();
    // Recompute the bent temples' lighting, preserving the original shading
    // of the front and lenses exactly, including custom normals/tangents.
    if(original.attributes.normal){
      for(let i=0;i<positions.count;i++)if(!movedFlags[i]){
        geometry.attributes.normal.setXYZ(i,original.attributes.normal.getX(i),original.attributes.normal.getY(i),original.attributes.normal.getZ(i));
      }
      geometry.attributes.normal.needsUpdate=true;
    }
    if(geometry.index&&geometry.attributes.uv)geometry.computeTangents();
    if(original.attributes.tangent&&geometry.attributes.tangent){
      const tangent=original.attributes.tangent;
      for(let i=0;i<positions.count;i++)if(!movedFlags[i])geometry.attributes.tangent.setXYZW(i,tangent.getX(i),tangent.getY(i),tangent.getZ(i),tangent.getW(i));
      geometry.attributes.tangent.needsUpdate=true;
    }
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    mesh.geometry=geometry;original.dispose();movedVertices+=moved;
  });
  if(!movedVertices)return null;
  gltf.scene.userData.templeFitApplied=true;
  return {estimated:true,maxLiftCm:1.35,maxSplayCm:1,movedVertices};
}
