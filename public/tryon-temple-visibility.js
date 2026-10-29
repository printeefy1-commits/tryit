import * as THREE from 'three';

// Clip a continuous rear suffix, not isolated patches of a fused AI mesh.
// Only the already prepared, known HEAD asset has this controller.
export function prepareTempleVisibility(gltf) {
  if(!gltf.scene.userData.templeFitApplied)return null;
  if(gltf.scene.userData.templeVisibility)return gltf.scene.userData.templeVisibility;
  const profile=gltf.asset.extras.lunetteCaba,anchor=new THREE.Vector3(...profile.anchor);
  const arms=[];gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh||!Array.isArray(mesh.material)||mesh.material.length!==2)return;
    const geometry=mesh.geometry,positions=geometry.attributes.position,index=geometry.index;
    const points=Array.from({length:positions.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).divideScalar(profile.referenceWidth));
    const front=[],lenses=[],parts=[[],[]],bins=[new Map(),new Map()];
    for(const group of geometry.groups)for(let i=group.start;i<group.start+group.count;i+=3){
      const ids=[index.getX(i),index.getX(i+1),index.getX(i+2)];
      if(group.materialIndex===1){lenses.push(...ids);continue;}
      const centre=ids.reduce((v,j)=>v.add(points[j]),new THREE.Vector3()).divideScalar(3);
      const distance=-1.5-centre.z*14;
      if(Math.abs(centre.x*14)<=5.3||distance<=0){front.push(...ids);continue;}
      const side=centre.x<0?0:1;
      parts[side].push({ids,end:Math.max(...ids.map(j=>-1.5-points[j].z*14))});
      for(const j of ids){
        const d=-1.5-points[j].z*14,k=Math.max(0,Math.floor(d*2));
        if(!bins[side].has(k))bins[side].set(k,new THREE.Box3());bins[side].get(k).expandByPoint(points[j]);
      }
    }
    const ordered=[...front];geometry.clearGroups();geometry.addGroup(0,front.length,0);
    parts.forEach((triangles,side)=>{
      triangles.sort((a,b)=>a.end-b.end);
      const group={start:ordered.length,count:triangles.length*3,materialIndex:0};geometry.groups.push(group);
      for(const t of triangles)ordered.push(...t.ids);
      arms.push({group,ends:triangles.map(t=>t.end),samples:[...bins[side]].sort((a,b)=>a[0]-b[0]).map(([,box])=>{
        const point=box.getCenter(new THREE.Vector3());return {point,distance:-1.5-point.z*14};
      }),cutoff:Infinity});
    });
    geometry.addGroup(ordered.length,lenses.length,1);ordered.push(...lenses);geometry.setIndex(ordered);
  });
  const control=arms.length?{arms}:null;gltf.scene.userData.templeVisibility=control;
  return control;
}

export function updateTempleVisibility(model,occluders) {
  const control=model.userData.templeVisibility;if(!control)return;
  model.updateMatrixWorld(true);
  for(const o of occluders){o.updateMatrixWorld(true);o.traverse(n=>{if(n.isMesh)n.geometry.computeBoundingSphere();});}
  const ray=new THREE.Raycaster(),point=new THREE.Vector3();
  for(const arm of control.arms){
    arm.cutoff=Infinity;
    for(const sample of arm.samples){
      point.copy(sample.point);model.localToWorld(point);
      const distance=point.length();ray.set(new THREE.Vector3(),point.clone().divideScalar(distance));ray.far=distance-.06;
      if(ray.intersectObjects(occluders,true).length){arm.cutoff=Math.max(0,sample.distance-.15);break;}
    }
    let count=0;while(count<arm.ends.length&&arm.ends[count]<=arm.cutoff)count++;
    arm.group.count=count*3;
  }
}
