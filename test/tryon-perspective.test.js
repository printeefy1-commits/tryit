import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {estimatePerspectiveFit,projectCameraPoint,trackingAlpha} from '../public/tryon-perspective.js';
import {createFaceOccluder,createHeadOccluder,updateRigidOccluders} from '../public/tryon-fit.js';
const canonical=JSON.parse(await fs.readFile(new URL('../public/models/canonical-face.json',import.meta.url))).vertices;
function observation(euler,aspect=4/3,depth=-55){
 const q=new THREE.Quaternion().setFromEuler(euler),t=new THREE.Vector3(2,-1,depth);
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
