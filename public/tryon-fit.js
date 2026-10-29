import * as THREE from 'three';

// MediaPipe z uses the same approximate scale as normalized x. Keep the face
// and glasses in one orthographic coordinate space so depth masking aligns.
export function landmarkPoint(point, aspect) {
  return new THREE.Vector3((point.x - 0.5) * 2 * aspect, (0.5 - point.y) * 2, -point.z * 2 * aspect);
}

export function estimateFit(face, aspect, scale = 1, offset = 0) {
  const point = index => landmarkPoint(face[index], aspect);
  const eyeCenter = (iris, a, b) => face[iris] ? point(iris) : point(a).add(point(b)).multiplyScalar(0.5);
  const left = eyeCenter(468, 33, 133);
  const right = eyeCenter(473, 362, 263);
  // Use 3D separation to compensate for projected eye spacing shrinking on turns.
  // 2.2 is an aesthetic initial fit, not a physical size measurement.
  const pupilDistance = left.distanceTo(right);
  if (!Number.isFinite(pupilDistance) || pupilDistance < 0.0001) return null;
  const horizontal = point(263).sub(point(33)).normalize();
  let vertical = point(10).sub(point(152));
  vertical.addScaledVector(horizontal, -vertical.dot(horizontal)).normalize();
  const normal = horizontal.clone().cross(vertical).normalize();
  if (normal.z < 0 || normal.lengthSq() < 0.5) return null;
  vertical = normal.clone().cross(horizontal).normalize();
  const rotation = new THREE.Matrix4().makeBasis(horizontal, vertical, normal);
  const position = left.clone().add(right).multiplyScalar(0.5);
  // Put the lens plane slightly in front of the nasal bridge, while the temples
  // extend backwards and are hidden by the tracked face depth mesh.
  position.z = point(168).z;
  position.addScaledVector(normal, pupilDistance * 0.06);
  position.addScaledVector(vertical, offset * pupilDistance);
  return {position, quaternion: new THREE.Quaternion().setFromRotationMatrix(rotation), width: pupilDistance * 2.2 * scale};
}

export function smoothLandmarks(previous, current, alpha) {
  if (!previous || previous.length !== current.length) return current.map(p => ({...p}));
  for (let i = 0; i < current.length; i++) {
    for (const axis of ['x', 'y', 'z']) previous[i][axis] += (current[i][axis] - previous[i][axis]) * alpha;
  }
  return previous;
}

export function createFaceOccluder(triangles) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3));
  geometry.setIndex(triangles);
  const material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: true, depthTest: true, side: THREE.DoubleSide});
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'tracked-face-depth-mask';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

export function updateFaceOccluder(mesh, face, aspect) {
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const p = landmarkPoint(face[i], aspect);
    positions.setXYZ(i, p.x, p.y, p.z);
  }
  positions.needsUpdate = true;
  mesh.visible = true;
}

// Rigid pose is supplied by MediaPipe's canonical-face transform. Re-estimate
// screen scale/translation over distributed facial anchors, not the far iris,
// whose predicted position can collapse when it is hidden in a profile view.
const POSE_ANCHORS=[4,6,10,33,54,67,70,93,127,132,133,152,168,172,197,234,251,263,284,297,300,323,356,361,362,397,454];
const YAW_ANCHORS=[4,6,33,133,168,197,263,362,70,107,336,300];
const HEAD_UP=new THREE.Vector3(0,1,0);

function projectionSamples(face,aspect,canonical,indices) {
  return indices.map(i=>{
    const observed=landmarkPoint(face[i],aspect);
    return {point:canonical[i],x:observed.x,y:observed.y,weight:[33,133,168,263,362].includes(i)?3:1};
  });
}

// Fit image scale/translation for a candidate rotation. This compares measured
// 2D features without relying on hidden irises or normalized landmark depth.
function screenProjection(samples,quaternion) {
  const e=new THREE.Matrix4().makeRotationFromQuaternion(quaternion).elements;
  let total=0,mx=0,my=0,ox=0,oy=0;
  const projected=samples.map(sample=>{
    const [x,y,z]=sample.point;
    const px=e[0]*x+e[4]*y+e[8]*z,py=e[1]*x+e[5]*y+e[9]*z,w=sample.weight;
    total+=w;mx+=w*px;my+=w*py;ox+=w*sample.x;oy+=w*sample.y;
    return {...sample,px,py};
  });
  mx/=total;my/=total;ox/=total;oy/=total;
  let numerator=0,denominator=0,spread=0;
  for(const {px,py,x,y,weight:w} of projected){
    numerator+=w*((px-mx)*(x-ox)+(py-my)*(y-oy));
    denominator+=w*((px-mx)**2+(py-my)**2);
    spread+=w*((x-ox)**2+(y-oy)**2);
  }
  const metricScale=numerator/denominator;
  if(!Number.isFinite(metricScale)||metricScale<=0||spread<1e-10)return null;
  const translation=new THREE.Vector3(ox-metricScale*mx,oy-metricScale*my,0);
  let error=0;
  for(const {px,py,x,y,weight:w} of projected)
    error+=w*((metricScale*px+translation.x-x)**2+(metricScale*py+translation.y-y)**2);
  return {metricScale,translation,error:error/spread};
}

function refineImageYaw(face,aspect,canonical,quaternion) {
  const forward=new THREE.Vector3(0,0,1).applyQuaternion(quaternion);
  // Pitch has already been validated on the owner's camera. Refine only the
  // lateral turn about the head's own up axis, not pitch/roll or frontal poses.
  const strength=THREE.MathUtils.smoothstep(Math.abs(forward.x),.2,.5)
    *(1-THREE.MathUtils.smoothstep(Math.abs(forward.y),.35,.65));
  if(strength<.01||forward.z<.2)return quaternion;
  const samples=projectionSamples(face,aspect,canonical,YAW_ANCHORS);
  const initial=screenProjection(samples,quaternion);
  if(!initial||initial.error<1e-8)return quaternion;
  const bound=THREE.MathUtils.degToRad(18)*strength,step=bound/6;
  const candidate=delta=>{
    const q=quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(HEAD_UP,delta));
    const projection=screenProjection(samples,q);
    return {q,delta,error:projection?.error??Infinity,
      cost:(projection?.error??Infinity)+initial.error*.04*(delta/bound)**2};
  };
  let best=candidate(0);
  for(let i=-6;i<=6;i++){const next=candidate(i*step);if(next.cost<best.cost)best=next;}
  let low=Math.max(-bound,best.delta-step),high=Math.min(bound,best.delta+step);
  for(let i=0;i<8;i++){
    const a=candidate(low+(high-low)/3),b=candidate(high-(high-low)/3);
    if(a.cost<b.cost)high=b.delta;else low=a.delta;
    if(a.cost<best.cost)best=a;if(b.cost<best.cost)best=b;
  }
  // Require evidence from the image rather than multiplying every yaw by a
  // fixed gain. Matrix rotation remains the prior and caps correction at 18°.
  const improvement=1-best.error/initial.error;
  return quaternion.clone().slerp(best.q,THREE.MathUtils.smoothstep(improvement,.15,.6));
}

export function estimateRigidFit(face,aspect,matrix,canonical,previousQuaternion=null,alpha=1,scale=1,offset=0,poseFace=face) {
  if(!matrix?.data||matrix.data.length!==16||!matrix.data.every(Number.isFinite))return null;
  const rotation=new THREE.Matrix4().extractRotation(new THREE.Matrix4().fromArray(matrix.data));
  let quaternion=new THREE.Quaternion().setFromRotationMatrix(rotation).normalize();
  quaternion=refineImageYaw(poseFace,aspect,canonical,quaternion);
  if(previousQuaternion)quaternion.copy(previousQuaternion.clone().slerp(quaternion,alpha));
  const rotated=canonical.map(v=>new THREE.Vector3(...v).applyQuaternion(quaternion));
  const projection=screenProjection(projectionSamples(face,aspect,canonical,POSE_ANCHORS),quaternion);
  if(!projection)return null;
  const {metricScale,translation}=projection;
  const forward=new THREE.Vector3(0,0,1).applyQuaternion(quaternion);
  const attachment=THREE.MathUtils.smoothstep(Math.abs(forward.x),.15,.5)
    *(1-THREE.MathUtils.smoothstep(Math.abs(forward.y),.55,.8));
  const observedRoot=landmarkPoint(face[168],aspect);
  const fittedRoot=rotated[168].clone().multiplyScalar(metricScale).add(translation);
  const residual=new THREE.Vector3(observedRoot.x-fittedRoot.x,observedRoot.y-fittedRoot.y,0);
  residual.clampLength(0,1.5*metricScale);
  translation.addScaledVector(residual,attachment);
  // Canonical face units are cm. Fourteen cm is an aesthetic nominal width,
  // not a measured product size. Fit the lens plane just in front of the bridge.
  const anchor=new THREE.Vector3(0,2.625+offset*6.3,5.5);
  const position=anchor.applyQuaternion(quaternion).multiplyScalar(metricScale).add(translation);
  // The canonical template is wide at the temples. Reserve side clearance in
  // the depth proxy so the near temple is not incorrectly buried in the head.
  // Screen-space face contours remain the measured landmarks, unchanged.
  const elements=new THREE.Matrix4().makeRotationFromQuaternion(quaternion).elements;
  const occlusionDepths=canonical.map(([x,y,z])=>{
    const side=THREE.MathUtils.smoothstep(Math.abs(x),5,7.8);
    const rear=THREE.MathUtils.smoothstep(3.2-z,0,5);
    const clearanceX=x*(1-.16*side*rear);
    return elements[2]*clearanceX+elements[6]*y+elements[10]*z;
  });
  return {position,quaternion,width:14*metricScale*scale,metricScale,translation,rotated,occlusionDepths,canonical};
}

export function createHeadOccluder() {
  const geometry=new THREE.SphereGeometry(1,32,24);
  // Extend around the scalp/back so disconnected temple tips do not show
  // through it. View-dependent depth clearance below preserves the near arm.
  // The facial template is widest at the cheekbones, not the cranium. Using
  // that full width for the scalp buries the near temple before it reaches the
  // ear, especially when a turn is combined with roll.
  geometry.scale(6.5,10,10);
  geometry.translate(0,3,-6);
  const material=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,material);
  mesh.name='head-volume-depth-mask';mesh.renderOrder=-11;mesh.visible=false;
  // A narrow temple band must not imply a narrow scalp. The upper hemisphere
  // hides temples seen through the forehead on a bow without covering a shaft
  // at ear height in a level side view. This remains an estimated head volume.
  const capGeometry=new THREE.SphereGeometry(1,32,20,0,Math.PI*2,0,Math.PI/2);
  capGeometry.scale(8.6,7.2,10);capGeometry.translate(0,5.8,-3.5);
  // Only the lateral scalp needs the extra width. Leave the middle to the
  // existing head/face proxies so a broad cap cannot cut the bridge on a bow.
  const capIndices=[],capPositions=capGeometry.attributes.position;
  for(let i=0;i<capGeometry.index.count;i+=3){
    const ids=[0,1,2].map(j=>capGeometry.index.getX(i+j));
    if(ids.every(j=>capPositions.getX(j)>4.5)||ids.every(j=>capPositions.getX(j)< -4.5))capIndices.push(...ids);
  }
  capGeometry.setIndex(capIndices);
  const cap=new THREE.Mesh(capGeometry,material.clone());
  cap.name='upper-scalp-depth-mask';cap.renderOrder=-11;cap.frustumCulled=false;
  mesh.add(cap);
  return mesh;
}

export function cameraDirectionInHead(fit) {
  // In perspective an off-centre head does not look along the optical axis.
  // Use the ray from the head origin to the camera, including its translation.
  const direction=fit.projection==='perspective'?fit.translation.clone().negate().normalize():new THREE.Vector3(0,0,1);
  return direction.applyQuaternion(fit.quaternion.clone().invert());
}

export function updateRigidOccluders(faceMesh,headMesh,face,aspect,fit) {
  const positions=faceMesh.geometry.attributes.position;
  // Camera direction in head coordinates also accounts for roll. World-space
  // forward.x alone can pick the wrong depth margin on a diagonal head tilt.
  const view=cameraDirectionInHead(fit);
  const turn=Math.abs(view.x);
  const bow=THREE.MathUtils.smoothstep(view.y,.25,.65);
  for(let i=0;i<positions.count;i++){
    const p=landmarkPoint(face[i],aspect);
    // A single setback for the whole face makes glasses show through the
    // nose, while still cutting off a near arm against the temple. Give those
    // two anatomical regions independent depth margins. Keep the nose tip and
    // ridge at skin depth; reserve bridge clearance only at the root on a bow.
    const [x,y,z]=fit.canonical[i];
    const nasal=(1-THREE.MathUtils.smoothstep(Math.abs(x),1.3,2.3))
      *THREE.MathUtils.smoothstep(y,-2.5,-.5)
      *(1-THREE.MathUtils.smoothstep(y,3.8,5));
    const root=THREE.MathUtils.smoothstep(y,.5,1.6);
    const bowedRoot=(1-THREE.MathUtils.smoothstep(Math.abs(x),1.5,3))*root
      *(1-THREE.MathUtils.smoothstep(y,5,6));
    const nearTemple=THREE.MathUtils.smoothstep(x*view.x,.3,1.5)
      *THREE.MathUtils.smoothstep(Math.abs(x),2.5,4.5)
      *THREE.MathUtils.smoothstep(5-z,0,3)
      *THREE.MathUtils.smoothstep(y,.5,1.8)
      *(1-THREE.MathUtils.smoothstep(y,6.5,8));
    const clearance=THREE.MathUtils.lerp(.3+1.5*turn,.08+.22*bow*root,nasal)
      +3*bow*bowedRoot+5*nearTemple;
    const depth=(fit.occlusionDepths[i]-clearance)*fit.metricScale+fit.translation.z;
    const projection=fit.projection==='perspective'?-depth/fit.focal:1;
    positions.setXYZ(i,p.x*projection,p.y*projection,depth);
  }
  positions.needsUpdate=true;faceMesh.visible=true;
  headMesh.position.copy(fit.translation);
  const headMargin=.5+3*turn;
  headMesh.position.z-=headMargin*fit.metricScale;
  headMesh.quaternion.copy(fit.quaternion);headMesh.scale.setScalar(fit.metricScale);headMesh.visible=true;
  const cap=headMesh.getObjectByName('upper-scalp-depth-mask');
  // The scalp is at its anatomical depth. Only the lower head proxy needs
  // the existing camera-depth setback that leaves room for the near temple.
  if(cap)cap.position.set(0,0,headMargin).applyQuaternion(fit.quaternion.clone().invert());
}

// Brief detector misses must not flash the glasses off. Never retain a stale
// pose indefinitely: a sustained loss still hides it and asks for a better view.
export class PoseContinuity {
  constructor(maxHoldMs=220){this.maxHoldMs=maxHoldMs;this.reset();}
  reset(){this.fit=null;this.lastSeen=-Infinity;}
  update(fit,now){
    if(fit){this.fit=fit;this.lastSeen=now;return {fit,held:false};}
    if(this.fit&&now-this.lastSeen<=this.maxHoldMs)return {fit:this.fit,held:true};
    this.reset();return {fit:null,held:false};
  }
}
