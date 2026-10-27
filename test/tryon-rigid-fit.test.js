import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {estimateRigidFit,createFaceOccluder,createHeadOccluder,updateRigidOccluders,PoseContinuity} from '../public/tryon-fit.js';
const canonical=JSON.parse(await fs.readFile(new URL('../public/models/canonical-face.json',import.meta.url))).vertices;
function observation(euler,aspect=4/3){
 const q=new THREE.Quaternion().setFromEuler(euler),s=.045,t=new THREE.Vector3(.12,-.07,0);
 const face=canonical.map(v=>{
  const p=new THREE.Vector3(...v).applyQuaternion(q).multiplyScalar(s).add(t);
  // Deliberately unreliable landmark depth: rigid fitting must not use it.
  return {x:.5+p.x/(2*aspect),y:.5-p.y/2,z:.7};
 });
 // Simulate the far iris being hidden and both iris predictions collapsing.
 face[468]={x:.5,y:.5,z:0};face[473]={x:.50001,y:.5,z:0};
 const matrix={data:new THREE.Matrix4().compose(new THREE.Vector3(2,-3,-40),q,new THREE.Vector3(1,1,1)).toArray()};
 return {q,s,t,face,matrix,aspect};
}

test('canonical pose stays full size through strong yaw and nods even with collapsed iris estimates',()=>{
 for(const euler of [new THREE.Euler(),new THREE.Euler(0,1.3,0),new THREE.Euler(0,-1.3,0),new THREE.Euler(1.0,.5,-.15),new THREE.Euler(-.6,.7,.2)]){
  const o=observation(euler),fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical);
  assert.ok(Math.abs(fit.width-14*o.s)<1e-8,'width is independent of far-eye visibility');
  assert.ok(fit.quaternion.angleTo(o.q)<1e-6);
  const expected=new THREE.Vector3(0,2.625,5.5).applyQuaternion(o.q).multiplyScalar(o.s).add(o.t);
  assert.ok(fit.position.distanceTo(expected)<1e-7,'lens-plane anchor follows the rigid pose during pitch');
 }
});

test('portrait layout and user scale/offset are preserved',()=>{
 const o=observation(new THREE.Euler(.7,-.9,.3),.75);
 const fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical,null,1,.8,.1);
 assert.ok(Math.abs(fit.width-14*o.s*.8)<1e-8);
 const expected=new THREE.Vector3(0,2.625+.63,5.5).applyQuaternion(o.q).multiplyScalar(o.s).add(o.t);
 assert.ok(fit.position.distanceTo(expected)<1e-7);
});

test('face and back-of-head masks share the same rigid depth reference',()=>{
 const o=observation(new THREE.Euler(.9,.7,0));const fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical);
 const face=createFaceOccluder([33,263,152]),head=createHeadOccluder();
 updateRigidOccluders(face,head,o.face,o.aspect,fit);
 assert.equal(head.material.colorWrite,false);assert.equal(head.material.depthWrite,true);assert.equal(head.visible,true);
 assert.ok(head.quaternion.angleTo(fit.quaternion)<1e-6);
 const i=168,actual=face.geometry.attributes.position.getZ(i);
 assert.ok(actual<fit.rotated[i].z*fit.metricScale,'nose proxy is set back to leave clearance for the bridge');
 assert.ok(actual>fit.rotated[i].z*fit.metricScale-5*fit.metricScale,'clearance is bounded in canonical units');
 assert.ok(head.position.z<fit.translation.z,'head depth margin preserves the near arm');
 head.geometry.computeBoundingBox();assert.ok(head.geometry.boundingBox.max.y>canonical[10][1],'mask extends above the facial surface');
 assert.ok(head.geometry.boundingBox.min.z<-8,'mask covers the back of the head');
 head.geometry.dispose();head.material.dispose();face.geometry.dispose();face.material.dispose();
});

test('invalid pose is rejected rather than producing non-finite transforms',()=>{
 const o=observation(new THREE.Euler());assert.equal(estimateRigidFit(o.face,o.aspect,{data:[NaN]},canonical),null);
});

test('lateral fit corrects a biased matrix using the observed facial projection',()=>{
 for(const direction of [-1,1]){
  const o=observation(new THREE.Euler(.08,direction*.96,-.06));
  const biased=new THREE.Quaternion().setFromEuler(new THREE.Euler(.08,direction*.72,-.06));
  o.matrix.data=new THREE.Matrix4().makeRotationFromQuaternion(biased).toArray();
  const fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical);
  assert.ok(fit.quaternion.angleTo(o.q)<.055,'rendered yaw should follow observed geometry, not inherit the full matrix bias');
  const fittedUp=new THREE.Vector3(0,1,0).applyQuaternion(fit.quaternion);
  const originalUp=new THREE.Vector3(0,1,0).applyQuaternion(biased);
  assert.ok(fittedUp.distanceTo(originalUp)<1e-6,'yaw refinement preserves the head up vector');
 }
});

test('lateral bridge stays attached when individual facial proportions differ from the template',()=>{
 for(const direction of [-1,1]){
  const o=observation(new THREE.Euler(0,direction*.96,0));
  // A more projecting nasal root than the average template. Contours remain
  // unchanged: a whole-face least-squares translation must not drag the bridge.
  for(const i of [6,168,197])o.face[i].x+=direction*.018;
  const fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical);
  const root=new THREE.Vector3(...canonical[168]).applyQuaternion(fit.quaternion).multiplyScalar(fit.metricScale).add(fit.translation);
  const observedX=(o.face[168].x-.5)*2*o.aspect;
  assert.ok(Math.abs(root.x-observedX)<1e-6,'nasal-root attachment must survive a lateral turn');
 }
});

test('yaw refinement uses current observations before a single pose smoothing step',()=>{
 const current=observation(new THREE.Euler(0,.96,0));
 const delayed=observation(new THREE.Euler(0,.72,0));
 const expected=delayed.q.clone().slerp(current.q,.5);
 const fit=estimateRigidFit(delayed.face,current.aspect,current.matrix,canonical,delayed.q,.5,1,0,current.face);
 assert.ok(fit.quaternion.angleTo(expected)<1e-6,'filtered landmarks must not apply a second delay to yaw');
});

test('near-side temple clearance does not change eye or nose depth',()=>{
 const o=observation(new THREE.Euler(0,1.3,0));const fit=estimateRigidFit(o.face,o.aspect,o.matrix,canonical);
 assert.ok(fit.occlusionDepths[127]<fit.rotated[127].z,'near-side depth proxy leaves clearance for the visible arm');
 for(const i of [33,133,168,263,362])assert.ok(Math.abs(fit.occlusionDepths[i]-fit.rotated[i].z)<1e-8);
});

test('short tracking interruptions retain pose but sustained loss cannot freeze an overlay',()=>{
 const continuity=new PoseContinuity(),fit={id:'last pose'};
 assert.equal(continuity.update(null,10).fit,null);
 assert.deepEqual(continuity.update(fit,100),{fit,held:false});
 assert.deepEqual(continuity.update(null,170),{fit,held:true});
 assert.deepEqual(continuity.update(null,300),{fit,held:true});
 assert.deepEqual(continuity.update(null,321),{fit:null,held:false});
 assert.equal(continuity.update(null,322).fit,null,'missing frames must not extend the deadline');
 const recovered={id:'new pose'};
 assert.deepEqual(continuity.update(recovered,400),{fit:recovered,held:false});
 continuity.reset();assert.equal(continuity.update(null,401).fit,null,'closing camera clears held pose');
});
