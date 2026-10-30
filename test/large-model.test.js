import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {prepareTempleVisibility} from '../public/tryon-temple-visibility.js';

test('dense lens index groups do not overflow the call stack or lose triangles',()=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-.2,0,0,.2,0,0,0,.1,0],3));
  const indices=Uint32Array.from({length:900000},(_,i)=>i%3);
  geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.clearGroups();geometry.addGroup(0,indices.length,1);
  const scene=new THREE.Group();scene.userData.templeFitApplied=true;
  scene.add(new THREE.Mesh(geometry,[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()]));
  assert.doesNotThrow(()=>prepareTempleVisibility({scene,asset:{extras:{lunetteCaba:{anchor:[0,0,0],referenceWidth:1}}}}));
  assert.equal(geometry.index.count,indices.length);assert.deepEqual(Array.from(geometry.index.array),Array.from(indices));
  assert.equal(geometry.groups.filter(g=>g.materialIndex===1).reduce((n,g)=>n+g.count,0),indices.length);
  geometry.dispose();
});
