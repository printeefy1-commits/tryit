import * as THREE from 'three';
import {isTempleRegion,isLensMaterial} from './tryon-ears.js';

// Partition each material independently: uploaded files may have one fused
// material, several frame materials, or lenses in any material slot.
export function prepareTempleVisibility(gltf) {
  if(!gltf.scene.userData.templeFitApplied)return null;
  if(gltf.scene.userData.templeVisibility)return gltf.scene.userData.templeVisibility;
  const profile=gltf.scene.userData.templeFitProfile||gltf.asset?.extras?.lunetteCaba;
  if(!profile)return null;
  const anchor=new THREE.Vector3(...profile.anchor),arms=[],sideBins=[new Map(),new Map()];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh||!mesh.geometry.attributes.position)return;
    const geometry=mesh.geometry,positions=geometry.attributes.position,index=geometry.index;
    const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material],count=index?.count??positions.count;
    const groups=Array.isArray(mesh.material)&&geometry.groups.length?geometry.groups:[{start:0,count,materialIndex:0}];
    const points=Array.from({length:positions.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).divideScalar(profile.referenceWidth));
    const buckets=new Map();
    for(const group of groups){
      const materialIndex=group.materialIndex??0;
      if(!buckets.has(materialIndex))buckets.set(materialIndex,{front:[],parts:[[],[]]});
      const {front,parts}=buckets.get(materialIndex);
      const lens=(profile.reviewed!==false&&Array.isArray(mesh.material)&&materialIndex===1)||isLensMaterial(materials[materialIndex]);
      for(let i=group.start;i<Math.min(count,group.start+group.count);i+=3){
        const ids=[0,1,2].map(j=>index?index.getX(i+j):i+j);
        const centre=ids.reduce((v,j)=>v.add(points[j]),new THREE.Vector3()).divideScalar(3);
        const distance=-1.5-centre.z*14;
        if(lens||!isTempleRegion(centre.x*14,centre.z*14+5.5)||distance<=0){for(const id of ids)front.push(id);continue;}
        const side=centre.x<0?0:1;
        parts[side].push({ids,end:Math.max(...ids.map(j=>-1.5-points[j].z*14))});
        for(const j of ids){
          const d=-1.5-points[j].z*14,k=Math.max(0,Math.floor(d*2));
          if(!sideBins[side].has(k))sideBins[side].set(k,new THREE.Box3());sideBins[side].get(k).expandByPoint(points[j]);
        }
      }
    }
    const total=[...buckets.values()].reduce((n,b)=>n+b.front.length+b.parts.reduce((n,p)=>n+p.length*3,0),0);
    const ordered=new (positions.count>65535?Uint32Array:Uint16Array)(total);
    let cursor=0;geometry.clearGroups();
    for(const [materialIndex,{front,parts}] of buckets){
      if(front.length){geometry.addGroup(cursor,front.length,materialIndex);ordered.set(front,cursor);cursor+=front.length;}
      parts.forEach((triangles,side)=>{
        if(!triangles.length)return;
        triangles.sort((a,b)=>a.end-b.end);
        const group={start:cursor,count:triangles.length*3,materialIndex};geometry.groups.push(group);
        for(const t of triangles)for(const id of t.ids)ordered[cursor++]=id;
        arms.push({side:side===0?-1:1,group,ends:triangles.map(t=>t.end),samples:[],cutoff:Infinity});
      });
    }
    geometry.setIndex(new THREE.BufferAttribute(ordered,1));
    // Three ignores geometry groups for a scalar material; an array is needed
    // for per-arm group counts to actually affect the rendered draw calls.
    if(!Array.isArray(mesh.material))mesh.material=[mesh.material];
  });
  // A screw or tip material need not span the whole shaft. Share the side's
  // centreline so all material groups stop at the same anatomical contact.
  const samples=sideBins.map(bins=>[...bins].sort((a,b)=>a[0]-b[0]).map(([,box])=>{
    const point=box.getCenter(new THREE.Vector3());return {point,distance:-1.5-point.z*14};
  }));
  for(const arm of arms)arm.samples=samples[arm.side<0?0:1];
  const control=arms.length?{arms}:null;gltf.scene.userData.templeVisibility=control;
  return control;
}

export function updateTempleVisibility(model,occluders) {
  const control=model.userData.templeVisibility;if(!control)return;
  model.updateMatrixWorld(true);
  for(const o of occluders){o.updateMatrixWorld(true);o.traverse(n=>{if(n.isMesh)n.geometry.computeBoundingSphere();});}
  const ray=new THREE.Raycaster(),point=new THREE.Vector3();
  const ears=occluders.find(o=>o.visible&&o.userData.templeSupport),support=ears?.userData.templeSupport;
  const inverseEar=ears?.matrixWorld.clone().invert();
  for(const arm of control.arms){
    arm.cutoff=Infinity;arm.earCutoff=Infinity;
    if(support){
      // Use the same head-space ear as the depth mask. This handles user scale,
      // measured frame width, translation, yaw, nods and roll together; a fixed
      // GLB-space length would miss the ear when any of those settings change.
      let previous;
      for(const sample of arm.samples){
        const local=model.localToWorld(sample.point.clone()).applyMatrix4(inverseEar);
        if(previous&&previous.local.z>support.z&&local.z<=support.z){
          const t=(previous.local.z-support.z)/(previous.local.z-local.z);
          const contact=previous.local.clone().lerp(local,t);
          if(contact.x*arm.side>0&&Math.abs(Math.abs(contact.x)-support.x)<=support.radiusX&&contact.y>=support.minY&&contact.y<=support.maxY){
            arm.earCutoff=THREE.MathUtils.lerp(previous.distance,sample.distance,t);arm.cutoff=arm.earCutoff;
          }
          break;
        }
        previous={local,distance:sample.distance};
      }
    }
    for(const sample of arm.samples){
      if(sample.distance>arm.cutoff)break;
      point.copy(sample.point);model.localToWorld(point);
      const distance=point.length();ray.set(new THREE.Vector3(),point.clone().divideScalar(distance));ray.far=distance-.06;
      if(ray.intersectObjects(occluders,true).length){arm.cutoff=Math.min(arm.cutoff,Math.max(0,sample.distance-.15));break;}
    }
    let low=0,high=arm.ends.length;
    while(low<high){const middle=(low+high)>>>1;if(arm.ends[middle]<=arm.cutoff)low=middle+1;else high=middle;}
    arm.group.count=low*3;
  }
}
