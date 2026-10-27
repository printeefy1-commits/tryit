import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {estimateFit, landmarkPoint, smoothLandmarks, createFaceOccluder, updateFaceOccluder} from '../public/tryon-fit.js';

// Synthetic head with fixed pupil spacing, generated under known rigid rotations.
function head(rotation=new THREE.Euler(), aspect=4/3, iris=true) {
  const q=new THREE.Quaternion().setFromEuler(rotation);
  const points={33:[-.15,0,0],133:[-.05,0,0],362:[.05,0,0],263:[.15,0,0],468:[-.10,0,0],473:[.10,0,0],10:[0,.3,0],152:[0,-.35,0],168:[0,0,.02]};
  const face=Array.from({length:iris?478:468},()=>({x:.5,y:.5,z:0}));
  for(const [index,xyz] of Object.entries(points)){
    if(+index>=face.length)continue;
    const v=new THREE.Vector3(...xyz).applyQuaternion(q);
    face[index]={x:.5+v.x/(2*aspect),y:.5-v.y/2,z:-v.z/(2*aspect)};
  }
  return {face,q};
}

test('fit uses pupil spacing rather than wider outer eye corners',()=>{
 const {face}=head();const fit=estimateFit(face,4/3);
 assert.ok(Math.abs(fit.width-.44)<1e-8);
 assert.ok(fit.position.z>landmarkPoint(face[168],4/3).z,'glasses sit in front of bridge');
 assert.ok(fit.position.y<.0001);
});

test('head turns and nods rotate the glasses without changing their intrinsic width',()=>{
 for(const euler of [new THREE.Euler(.45,0,0),new THREE.Euler(-.4,.6,0),new THREE.Euler(0,-.65,.3),new THREE.Euler(.3,.6,-.2)]){
  const {face,q}=head(euler);const fit=estimateFit(face,4/3);
  assert.ok(fit.quaternion.angleTo(q)<1e-6);
  assert.ok(Math.abs(fit.width-.44)<1e-7);
 }
});

test('fallback eye centers and portrait aspect preserve expected fit',()=>{
 const {face}=head(new THREE.Euler(0,.5,0),.75,false);const fit=estimateFit(face,.75,.8,.1);
 assert.ok(Math.abs(fit.width-.44*.8)<1e-7);
 assert.ok(fit.position.y>0);
});

test('depth mask follows the same face projection and writes depth without color',()=>{
 const {face}=head();const mesh=createFaceOccluder([33,263,152]);
 updateFaceOccluder(mesh,face,4/3);
 const p=landmarkPoint(face[263],4/3),attr=mesh.geometry.attributes.position;
 assert.ok(Math.abs(attr.getX(263)-p.x)<1e-7);
 assert.equal(mesh.material.colorWrite,false);assert.equal(mesh.material.depthWrite,true);
 assert.equal(mesh.visible,true);assert.ok(mesh.renderOrder<0);
 mesh.geometry.dispose();mesh.material.dispose();
});

test('landmark smoothing damps noise and resets when the face shape changes',()=>{
 const a=[{x:0,y:0,z:0}],b=[{x:1,y:1,z:1}];
 assert.equal(smoothLandmarks(a,b,.25)[0].x,.25);
 assert.equal(smoothLandmarks(null,b,.25)[0].x,1);
});
