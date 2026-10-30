import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createEarOccluders,updateEarOccluders,TEMPLE_SUPPORT} from '../public/tryon-ears.js';
import {updateTempleVisibility} from '../public/tryon-temple-visibility.js';

function fixture(frameScale=1,pitch=0,yaw=0,roll=0,metricScale=1){
 const fit={translation:new THREE.Vector3(5,-3,-40),quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,roll)),metricScale};
 const ears=createEarOccluders();
 // These samples deliberately run above the ear volume. The anatomical
 // terminal cutoff must work even when no camera ray hits an ear triangle.
 for(const child of ears.children){child.geometry.dispose();child.material.dispose();}ears.clear();updateEarOccluders(ears,fit);
 const model=new THREE.Group();model.position.set(0,2.625,5.5).applyQuaternion(fit.quaternion).multiplyScalar(metricScale).add(fit.translation);model.quaternion.copy(fit.quaternion);model.scale.setScalar(14*frameScale*metricScale);
 const arms=[-1,1].map(side=>{
  const samples=Array.from({length:69},(_,i)=>{const distance=i*.25,z=4-distance;return {distance,point:new THREE.Vector3(side*7.2/14,(4.8-2.625)/14,(z-5.5)/14)};});
  const ends=samples.slice(1).map(s=>s.distance);return {side,samples,ends,group:{start:0,count:ends.length*3},cutoff:Infinity};
 });
 model.userData.templeVisibility={arms};return {model,ears,arms};
}

test('an extended shaft terminates at the upper ear even when it passes above the depth-mask ellipsoid',()=>{
 for(const frameScale of [.9,1,1.1])for(const [pitch,yaw,roll,metric] of [[0,0,0,1],[.5,1,.4,.9],[.6,-1,-.4,1.1],[1.1,.25,.6,1],[-.8,-.6,.2,1]]){
  const {model,ears,arms}=fixture(frameScale,pitch,yaw,roll,metric);
  updateTempleVisibility(model,[ears]);
  const expected=-1.5+(5.5-(TEMPLE_SUPPORT.contactZ-TEMPLE_SUPPORT.overlapCm))/frameScale;
  for(const arm of arms){
   assert.ok(Math.abs(arm.earCutoff-expected)<1e-9,'contact follows the ear in head space, including frame width and pose');
   assert.ok(arm.group.count>0&&arm.group.count<arm.ends.length*3,'a connected front run remains, with no exposed rear hook');
   assert.ok(arm.ends.slice(0,arm.group.count/3).every(end=>end<=arm.cutoff));
   assert.ok(arm.ends.slice(arm.group.count/3).every(end=>end>arm.cutoff),'no later fragment can reappear beyond the ear');
  }
  updateTempleVisibility(model,[]);for(const arm of arms)assert.equal(arm.group.count,arm.ends.length*3,'admin preview without ears retains the whole extended model');
 }
});

test('a genuine head obstruction can still hide a shaft before it reaches the ear, independently on each side',()=>{
 const {model,ears,arms}=fixture();model.updateMatrixWorld(true);
 const point=model.localToWorld(arms[0].samples[20].point.clone()),mask=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
 mask.position.copy(point).addScaledVector(point.clone().normalize(),-.3);mask.updateMatrixWorld(true);
 updateTempleVisibility(model,[ears,mask]);
 assert.ok(arms[0].cutoff<arms[0].earCutoff,'head depth still takes priority over the ear limit');
 assert.ok(Math.abs(arms[1].cutoff-arms[1].earCutoff)<1e-9,'the other arm reaches its own ear');
 mask.geometry.dispose();mask.material.dispose();
});
