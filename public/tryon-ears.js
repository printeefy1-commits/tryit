import * as THREE from 'three';
import {knownModelProfile} from './tryon-model-profiles.js';

// MediaPipe's face mesh has no ear landmarks. These are deliberately labelled
// template dimensions in canonical cm, not detected ear edges or measurements.
export const EAR_TEMPLATE=Object.freeze({x:6.9,y:1.95,z:-7.3,radiusX:.65,radiusY:2.45,radiusZ:1.6});
export const TEMPLE_SUPPORT=Object.freeze({lengthScale:1.2,hingeZ:4,innerX:4.5,
  lowerEdgeY:EAR_TEMPLATE.y+EAR_TEMPLATE.radiusY+.02,contactX:EAR_TEMPLATE.x+.05,contactZ:EAR_TEMPLATE.z,overlapCm:.2});

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

// The known generated HEAD mesh bends down too early, ending across the ear
// opening. Lift only its rear temples smoothly toward the estimated upper rim.
// The lens/bridge/hinge positions, UVs, material assignments and source GLB stay
// intact. This is an aesthetic fitting adjustment, not a new measured product.
export function prepareKnownTempleFit(gltf) {
  const profile=gltf.asset?.extras?.lunetteCaba;
  const tuning=knownModelProfile(gltf)?.templeFit;
  if(!tuning||gltf.scene.userData.templeFitApplied)return null;
  if(!Array.isArray(profile.anchor)||profile.anchor.length!==3||!profile.anchor.every(Number.isFinite)
    ||!Number.isFinite(profile.referenceWidth)||profile.referenceWidth<=0)return null;
  const anchor=new THREE.Vector3(...profile.anchor),point=new THREE.Vector3();
  const sourcePerCm=profile.referenceWidth/14;
  let movedVertices=0,maxLiftCm=0,maxExtensionCm=0,maxSplayCm=0;
  const records=[],edges=[new Map(),new Map()];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const original=mesh.geometry,geometry=original.clone(),positions=geometry.attributes.position;
    const movedFlags=new Uint8Array(positions.count),canonical=new Float32Array(positions.count*3);
    const lensVertices=new Uint8Array(positions.count);
    if(Array.isArray(mesh.material)&&geometry.index){
      for(const group of geometry.groups)if(group.materialIndex===1){
        for(let j=group.start;j<group.start+group.count;j++)lensVertices[geometry.index.getX(j)]=1;
      }
    }
    for(let i=0;i<positions.count;i++){
      point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).divideScalar(sourcePerCm);
      point.y+=2.625;point.z+=5.5;
      const {x,z}=point;
      if(lensVertices[i]||!isTempleRegion(x,z))continue;
      if(Math.abs(x)>5.3){
        point.y+=tuning.firstLiftCm*THREE.MathUtils.smoothstep(4-z,0,7)
          +tuning.rearLiftCm*THREE.MathUtils.smoothstep(-2.5-z,0,3);
        point.x+=Math.sign(x)*tuning.splayCm*THREE.MathUtils.smoothstep(4-z,0,5.5);
        point.z-=tuning.extensionCm*THREE.MathUtils.smoothstep(4-z,0,8);
      }
      // Scale rear reach about the hinge, never the entire glasses. Include
      // inward-curving hook vertices so the mesh stays connected at the tip.
      point.z=TEMPLE_SUPPORT.hingeZ-(TEMPLE_SUPPORT.hingeZ-point.z)*TEMPLE_SUPPORT.lengthScale;
      point.toArray(canonical,i*3);movedFlags[i]=1;
      const side=x<0?0:1,k=Math.floor(point.z*2),edge=edges[side];
      const previous=edge.get(k),outerX=Math.abs(point.x);
      edge.set(k,{y:Math.min(previous?.y??Infinity,point.y),minX:Math.min(previous?.minX??Infinity,outerX),maxX:Math.max(previous?.maxX??-Infinity,outerX)});
    }
    records.push({mesh,original,geometry,positions,movedFlags,canonical});
  });
  // A lower-edge envelope retains the arm's thickness and cross-section.
  // Lift low shafts toward the upper helix, not every vertex onto one plane.
  const paths=edges.map(edge=>[...edge].sort((a,b)=>a[0]-b[0]).map(([k,value],i,array)=>({
    z:(k+.5)/2,y:(array[i-1]?.[1].y??value.y)*.25+value.y*.5+(array[i+1]?.[1].y??value.y)*.25,
    x:(value.minX+value.maxX)/2
  })));
  const envelope=(side,z)=>{
    const path=paths[side];if(!path.length)return {y:TEMPLE_SUPPORT.lowerEdgeY,x:TEMPLE_SUPPORT.contactX};
    let low=0,high=path.length;
    while(low<high){const middle=(low+high)>>>1;if(path[middle].z<z)low=middle+1;else high=middle;}
    if(!low)return path[0];if(low===path.length)return path.at(-1);
    const a=path[low-1],b=path[low],t=(z-a.z)/(b.z-a.z);
    return {y:THREE.MathUtils.lerp(a.y,b.y,t),x:THREE.MathUtils.lerp(a.x,b.x,t)};
  };
  for(const {mesh,original,geometry,positions,movedFlags,canonical} of records){
    const inverse=mesh.matrixWorld.clone().invert(),before=new THREE.Vector3();let moved=0;
    for(let i=0;i<positions.count;i++)if(movedFlags[i]){
      point.fromArray(canonical,i*3);
      const approach=THREE.MathUtils.smoothstep(TEMPLE_SUPPORT.hingeZ-point.z,6.5,10.5);
      const hook=1-THREE.MathUtils.smoothstep(TEMPLE_SUPPORT.contactZ-point.z,.2,1.5);
      const edge=envelope(point.x<0?0:1,point.z),weight=approach*hook;
      const lift=Math.max(0,TEMPLE_SUPPORT.lowerEdgeY-edge.y)*weight;
      point.y+=lift;
      // Settle the last few millimetres into the helix so its depth mask hides
      // the end. The long downward hook remains behind the terminal cutoff.
      const contact=THREE.MathUtils.smoothstep(TEMPLE_SUPPORT.contactZ-point.z,-.3,.2)*weight;
      point.y-=(edge.y+lift-(TEMPLE_SUPPORT.lowerEdgeY-.18))*contact;
      point.x+=Math.sign(point.x)*(TEMPLE_SUPPORT.contactX-edge.x)*weight;
      before.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).divideScalar(sourcePerCm);
      before.y+=2.625;before.z+=5.5;
      maxLiftCm=Math.max(maxLiftCm,point.y-before.y);maxExtensionCm=Math.max(maxExtensionCm,before.z-point.z);
      maxSplayCm=Math.max(maxSplayCm,Math.sign(before.x)*(point.x-before.x));
      point.y-=2.625;point.z-=5.5;point.multiplyScalar(sourcePerCm).add(anchor).applyMatrix4(inverse);
      positions.setXYZ(i,point.x,point.y,point.z);moved++;
    }
    if(!moved){geometry.dispose();continue;}
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
  }
  if(!movedVertices)return null;
  gltf.scene.userData.templeFitApplied=true;
  return {estimated:true,lengthScale:TEMPLE_SUPPORT.lengthScale,supportLowerEdgeY:TEMPLE_SUPPORT.lowerEdgeY,maxLiftCm,maxSplayCm,maxExtensionCm,movedVertices};
}
