import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {estimatePerspectiveFit,projectCameraPoint,trackingAlpha} from '../public/tryon-perspective.js';
import {createFaceOccluder,createHeadOccluder,updateRigidOccluders,cameraDirectionInHead} from '../public/tryon-fit.js';
const canonical=JSON.parse(await fs.readFile(new URL('../public/models/canonical-face.json',import.meta.url))).vertices;
function observation(euler,aspect=4/3,depth=-55,tx=2,ty=-1){
 const q=new THREE.Quaternion().setFromEuler(euler),t=new THREE.Vector3(tx,ty,depth);
 const face=canonical.map(v=>({...projectCameraPoint(new THREE.Vector3(...v).applyQuaternion(q).add(t),aspect),z:.8}));
 const matrix={data:new THREE.Matrix4().compose(t,q,new THREE.Vector3(1,1,1)).toArray()};
 return {q,t,face,matrix,aspect};
}

test('perspective pose recovers turns, nods and camera distance with asymmetric near/far projection',()=>{
 for(const euler of [new THREE.Euler(),new THREE.Euler(0,1.2,0),new THREE.Euler(0,-1.2,0),new THREE.Euler(1,0,.15),new THREE.Euler(-1,.3,0)]){
  for(const aspect of [4/3,.75]){
   const o=observation(euler,aspect),fit=estimatePerspectiveFit(o.face,aspect,o.matrix,canonical);
   assert.ok(fit);assert.ok(fit.quaternion.angleTo(o.q)<.001);
   assert.ok(fit.translation.distanceTo(o.t)<.01);
   assert.equal(fit.width,14);assert.ok(fit.reprojectionError<.0001);
  }
 }
});

test('perspective pose corrects inaccurate matrix yaw instead of treating it as ground truth',()=>{
 for(const direction of [-1,1]){
  const o=observation(new THREE.Euler(.1,direction*.96,-.07));
  const biased=new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,direction*.72,-.07));
  o.matrix.data=new THREE.Matrix4().makeRotationFromQuaternion(biased).toArray();
  const fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
  assert.ok(fit);assert.ok(fit.quaternion.angleTo(o.q)<.01);assert.ok(fit.translation.distanceTo(o.t)<.05);
 }
});

test('depth and lens-plane attachment use one perspective reference',()=>{
 const o=observation(new THREE.Euler(.2,-.8,0),4/3,-35);
 const fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical,null,1,.8,.1);
 const expected=new THREE.Vector3(0,2.625+.63,5.5).applyQuaternion(o.q).add(o.t);
 assert.ok(fit.position.distanceTo(expected)<.01);assert.ok(Math.abs(fit.width-11.2)<1e-9);
 const near=projectCameraPoint(new THREE.Vector3(-6,3,2).applyQuaternion(o.q).add(o.t));
 const far=projectCameraPoint(new THREE.Vector3(6,3,2).applyQuaternion(o.q).add(o.t));
 assert.notEqual(near.y,far.y,'perspective has different magnification on near and far sides');
});

test('motion-adaptive smoothing follows a fast movement while damping small stationary noise',()=>{
 const o=observation(new THREE.Euler()),stationary=o.face.map(p=>({...p,x:p.x+.0001}));
 const fast=o.face.map(p=>({...p,x:p.x+.06}));
 const a=trackingAlpha(o.face,stationary,1/30),b=trackingAlpha(o.face,fast,1/30);
 assert.ok(a<.55);assert.ok(b>.95);assert.equal(trackingAlpha(null,fast,1/30),1);
});

test('invalid perspective inputs hide the model rather than producing infinite transforms',()=>{
 const o=observation(new THREE.Euler());
 assert.equal(estimatePerspectiveFit(o.face,o.aspect,{data:[NaN]},canonical),null);
 o.face[168].x=NaN;assert.equal(estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical),null);
});

test('moving a perspective depth proxy backwards preserves the observed face silhouette',()=>{
 const o=observation(new THREE.Euler(.3,1,0)),fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
 const mesh=createFaceOccluder([33,263,152]),head=createHeadOccluder();
 updateRigidOccluders(mesh,head,o.face,o.aspect,fit);
 for(const i of [4,6,33,127,168,263,356]){
  const p=new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i),screen=projectCameraPoint(p,o.aspect);
  assert.ok(Math.abs(screen.x-o.face[i].x)<1e-6);assert.ok(Math.abs(screen.y-o.face[i].y)<1e-6);
 }
 mesh.geometry.dispose();mesh.material.dispose();head.geometry.dispose();head.material.dispose();
});

test('nose remains at skin depth on turns while the bridge keeps clearance on a bow',()=>{
 const mesh=createFaceOccluder([4,6,197]),head=createHeadOccluder();
 for(const euler of [new THREE.Euler(0,1,0),new THREE.Euler(0,-1,0),new THREE.Euler(.3,.45,.55)]){
  const o=observation(euler),fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
  updateRigidOccluders(mesh,head,o.face,o.aspect,fit);
  const view=cameraDirectionInHead(fit);
  for(const i of view.y<.25?[4,6,197]:[4]){
   const setback=fit.rotated[i].z+fit.translation.z-mesh.geometry.attributes.position.getZ(i);
   assert.ok(setback>=0&&setback<.15,'a surface behind the nose must not show through skin');
  }
 }
 const o=observation(new THREE.Euler(1,0,0)),fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
 updateRigidOccluders(mesh,head,o.face,o.aspect,fit);
 assert.ok(fit.rotated[168].z+fit.translation.z-mesh.geometry.attributes.position.getZ(168)>2,'bowing retains root clearance');
 mesh.geometry.dispose();mesh.material.dispose();head.geometry.dispose();head.material.dispose();
});

test('temple clearance follows the camera side in head space even when pitch and roll reverse it',()=>{
 const mesh=createFaceOccluder([127,356,168]),head=createHeadOccluder();
 for(const direction of [-1,1]){
  const o=observation(new THREE.Euler(.8,direction*.6,direction*1.2));
  const fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
  updateRigidOccluders(mesh,head,o.face,o.aspect,fit);
  const view=new THREE.Vector3(0,0,1).applyQuaternion(fit.quaternion.clone().invert());
  const near=view.x>0?356:127,far=view.x>0?127:356;
  const setback=i=>fit.rotated[i].z+fit.translation.z-mesh.geometry.attributes.position.getZ(i);
  assert.ok(setback(near)>setback(far)+3,'the near temple needs space without exposing the opposite arm');
 }
 mesh.geometry.dispose();mesh.material.dispose();head.geometry.dispose();head.material.dispose();
});

test('perspective temple clearance switches to the visible side as a turned head moves across the camera',()=>{
 const mesh=createFaceOccluder([127,356,168]),head=createHeadOccluder();
 for(const tx of [0,-12]){
  const o=observation(new THREE.Euler(0,.16,0),4/3,-40,tx,0);
  const fit=estimatePerspectiveFit(o.face,o.aspect,o.matrix,canonical);
  updateRigidOccluders(mesh,head,o.face,o.aspect,fit);
  const view=cameraDirectionInHead(fit),near=tx===0?127:356,far=tx===0?356:127;
  assert.ok(tx===0?view.x<0:view.x>0,'the viewing side depends on camera position as well as head yaw');
  const setback=i=>fit.rotated[i].z+fit.translation.z-mesh.geometry.attributes.position.getZ(i);
  assert.ok(setback(near)>setback(far)+1,'side clearance must follow the actual perspective view');
  assert.ok(fit.quaternion.angleTo(o.q)<.001,'moving across the camera must not invent extra head rotation');
 }
 mesh.geometry.dispose();mesh.material.dispose();head.geometry.dispose();head.material.dispose();
});
