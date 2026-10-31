import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {updateTempleVisibility} from '../public/tryon-temple-visibility.js';

function fixture(){
 const model=new THREE.Group();model.position.z=-10;
 const samples=Array.from({length:21},(_,i)=>({distance:i*.5,point:new THREE.Vector3(-1+i*.1,0,0)}));
 const arm={side:1,samples,ends:samples.map(s=>s.distance),group:{start:0,count:samples.length*3}};
 model.userData.templeVisibility={arms:[arm]};
 const geometry=new THREE.PlaneGeometry(.4,.4);geometry.translate(10,0,0);
 const mask=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mask.position.z=-9;
 const compute=geometry.computeBoundingSphere.bind(geometry);let scans=0;
 geometry.computeBoundingSphere=()=>{scans++;compute();};
 return {model,arm,geometry,mask,get scans(){return scans;}};
}

test('rigid occluders reuse bounds across frame poses, while position edits refresh broad-phase ray tests',()=>{
 const f=fixture();updateTempleVisibility(f.model,[f.mask]);
 assert.equal(f.scans,1);assert.equal(f.arm.cutoff,Infinity);
 for(let i=0;i<5;i++){f.mask.rotation.z=i*.03;updateTempleVisibility(f.model,[f.mask]);}
 assert.equal(f.scans,1,'changing the mask pose does not rescan its unchanged local vertices');
 const p=f.geometry.attributes.position;
 for(let i=0;i<p.count;i++)p.setX(i,p.getX(i)-10);p.needsUpdate=true;
 updateTempleVisibility(f.model,[f.mask]);
 assert.equal(f.scans,2);assert.ok(Number.isFinite(f.arm.cutoff),'moved vertices must now obstruct the shaft even though their old sphere was far away');
 assert.ok(f.arm.group.count<f.arm.ends.length*3);
 updateTempleVisibility(f.model,[f.mask]);assert.equal(f.scans,2);
 f.mask.position.x=10;updateTempleVisibility(f.model,[f.mask]);
 assert.equal(f.scans,2);assert.equal(f.arm.cutoff,Infinity,'rigid movement still updates world-space ray intersections');
 assert.equal(f.arm.group.count,f.arm.ends.length*3);
 f.geometry.boundingSphere=null;updateTempleVisibility(f.model,[f.mask]);assert.equal(f.scans,3,'explicit invalidation is respected');
 f.geometry.index.needsUpdate=true;updateTempleVisibility(f.model,[f.mask]);assert.equal(f.scans,4,'index-version changes are conservative invalidations');
 f.geometry.setAttribute('position',p.clone());updateTempleVisibility(f.model,[f.mask]);assert.equal(f.scans,5,'a replacement attribute with the same version is still new geometry');
 f.geometry.dispose();f.mask.material.dispose();
});

test('interleaved position edits invalidate cached bounds via their shared buffer version',()=>{
 const f=fixture(),p=f.geometry.attributes.position;
 const data=new THREE.InterleavedBuffer(new Float32Array(p.array),3);
 const interleaved=new THREE.InterleavedBufferAttribute(data,3,0);
 f.geometry.setAttribute('position',interleaved);
 updateTempleVisibility(f.model,[f.mask]);assert.equal(f.scans,1);assert.equal(f.arm.cutoff,Infinity);
 for(let i=0;i<interleaved.count;i++)interleaved.setX(i,interleaved.getX(i)-10);
 interleaved.needsUpdate=true;
 updateTempleVisibility(f.model,[f.mask]);
 assert.equal(f.scans,2);assert.ok(Number.isFinite(f.arm.cutoff));
 f.geometry.dispose();f.mask.material.dispose();
});
