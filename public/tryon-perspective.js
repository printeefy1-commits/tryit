import * as THREE from 'three';

// Approximate intrinsics, normalized by half the image height. This is a camera
// prior, not a measurement of the customer's webcam or physical face size.
export const CAMERA_FOCAL=1.8;
export const CAMERA_FOV=THREE.MathUtils.radToDeg(2*Math.atan(1/CAMERA_FOCAL));
const ANCHORS=[4,6,9,10,33,54,70,105,107,127,133,152,168,197,234,263,284,300,334,336,356,362,454];
const EYES=new Set([33,133,263,362]);
const NOSE=new Set([6,168,197]);

function samplesFor(face,aspect,canonical,q) {
  const turn=new THREE.Vector3(0,0,1).applyQuaternion(q).x;
  return ANCHORS.map(i=>{
    const point=new THREE.Vector3(...canonical[i]);
    let weight=EYES.has(i)?2:NOSE.has(i)?2.5:.6;
    if(Math.abs(point.x)>1&&point.x*turn>0)weight*=1-.6*THREE.MathUtils.smoothstep(Math.abs(turn),.4,.85);
    return {point,x:(face[i].x-.5)*2*aspect,y:(.5-face[i].y)*2,weight};
  });
}

function initialize(samples,q) {
  const rotated=samples.map(s=>s.point.clone().applyQuaternion(q));
  let w=0,mx=0,my=0,mz=0,ox=0,oy=0;
  samples.forEach((s,i)=>{const r=rotated[i];w+=s.weight;mx+=s.weight*r.x;my+=s.weight*r.y;mz+=s.weight*r.z;ox+=s.weight*s.x;oy+=s.weight*s.y;});
  mx/=w;my/=w;mz/=w;ox/=w;oy/=w;
  let n=0,d=0;
  samples.forEach((s,i)=>{const r=rotated[i];n+=s.weight*((r.x-mx)*(s.x-ox)+(r.y-my)*(s.y-oy));d+=s.weight*((r.x-mx)**2+(r.y-my)**2);});
  const scale=n/d;
  if(!Number.isFinite(scale)||scale<=0)return null;
  return new THREE.Vector3(ox/scale-mx,oy/scale-my,-CAMERA_FOCAL/scale-mz);
}

function evaluate(samples,q,t,derivatives=false) {
  const h=Array.from({length:6},()=>Array(6).fill(0)),g=Array(6).fill(0);
  let cost=0,total=0;
  for(const sample of samples){
    const r=sample.point.clone().applyQuaternion(q),p=r.clone().add(t);
    if(p.z>=-2)return null;
    const k=CAMERA_FOCAL/-p.z,u=k*p.x,v=k*p.y;
    const ex=sample.x-u,ey=sample.y-v,error=Math.hypot(ex,ey),limit=.02;
    const weight=sample.weight*(error>limit?limit/error:1);
    cost+=sample.weight*(error<=limit?error*error:2*limit*error-limit*limit);total+=sample.weight;
    if(!derivatives)continue;
    const zx=CAMERA_FOCAL*p.x/(p.z*p.z),zy=CAMERA_FOCAL*p.y/(p.z*p.z);
    const ju=[zx*r.y,k*r.z-zx*r.x,-k*r.y,k,0,zx];
    const jv=[-k*r.z+zy*r.y,-zy*r.x,k*r.x,0,k,zy];
    for(let a=0;a<6;a++){
      g[a]+=weight*(ju[a]*ex+jv[a]*ey);
      for(let b=0;b<6;b++)h[a][b]+=weight*(ju[a]*ju[b]+jv[a]*jv[b]);
    }
  }
  return {cost:cost/total,h,g};
}

function solve(h,g,damping) {
  const rows=h.map((row,i)=>[...row.map((v,j)=>v+(i===j?damping*(h[i][i]+1e-6):0)),g[i]]);
  for(let c=0;c<6;c++){
    let pivot=c;for(let r=c+1;r<6;r++)if(Math.abs(rows[r][c])>Math.abs(rows[pivot][c]))pivot=r;
    if(Math.abs(rows[pivot][c])<1e-12)return null;
    [rows[c],rows[pivot]]=[rows[pivot],rows[c]];
    const divisor=rows[c][c];for(let j=c;j<=6;j++)rows[c][j]/=divisor;
    for(let r=0;r<6;r++)if(r!==c){const f=rows[r][c];for(let j=c;j<=6;j++)rows[r][j]-=f*rows[c][j];}
  }
  return rows.map(row=>row[6]);
}

export function projectCameraPoint(point,aspect=1) {
  return {x:.5+CAMERA_FOCAL*point.x/(-point.z*2*aspect),y:.5-CAMERA_FOCAL*point.y/(-point.z*2)};
}

export function estimatePerspectiveFit(face,aspect,matrix,canonical,previous=null,alpha=1,scale=1,offset=0) {
  if(!matrix?.data||matrix.data.length!==16||!matrix.data.every(Number.isFinite))return null;
  if(ANCHORS.some(i=>!face[i]||!Number.isFinite(face[i].x)||!Number.isFinite(face[i].y)))return null;
  const rotation=new THREE.Matrix4().extractRotation(new THREE.Matrix4().fromArray(matrix.data));
  const prior=new THREE.Quaternion().setFromRotationMatrix(rotation).normalize();
  const samples=samplesFor(face,aspect,canonical,prior);
  let quaternion=prior.clone(),translation=initialize(samples,quaternion);
  if(!translation)return null;
  let state=evaluate(samples,quaternion,translation,true),damping=.001,iterations=0;
  if(!state)return null;
  for(;iterations<16;iterations++){
    const delta=solve(state.h,state.g,damping);if(!delta||!delta.every(Number.isFinite))break;
    const r=new THREE.Vector3(...delta.slice(0,3)),t=new THREE.Vector3(...delta.slice(3));
    const fraction=Math.min(1,.18/Math.max(r.length(),1e-9),5/Math.max(t.length(),1e-9));r.multiplyScalar(fraction);t.multiplyScalar(fraction);
    const angle=r.length(),dq=angle>1e-10?new THREE.Quaternion().setFromAxisAngle(r.divideScalar(angle),angle):new THREE.Quaternion();
    let q=dq.multiply(quaternion).normalize();
    const departure=prior.angleTo(q);if(departure>.55)q=prior.clone().slerp(q,.55/departure);
    const position=translation.clone().add(t);position.z=THREE.MathUtils.clamp(position.z,-250,-18);
    const next=evaluate(samples,q,position);
    if(next&&next.cost<state.cost){
      const improvement=state.cost-next.cost;
      quaternion=q;translation=position;state=evaluate(samples,q,position,true);damping=Math.max(1e-6,damping*.4);
      if(improvement<1e-10)break;
    }else damping=Math.min(1e5,damping*10);
  }
  if(Math.sqrt(state.cost)>.09)return null;
  // Attach the nasal root in image space; depth and rigid perspective remain
  // consistent for both the model and masks. Bound anatomical mismatch.
  const root=new THREE.Vector3(...canonical[168]).applyQuaternion(quaternion).add(translation);
  const observed=face[168],forward=new THREE.Vector3(0,0,1).applyQuaternion(quaternion);
  const attachment=THREE.MathUtils.smoothstep(Math.abs(forward.x),.15,.5);
  const residual=new THREE.Vector3((observed.x-.5)*2*aspect*-root.z/CAMERA_FOCAL-root.x,
    (.5-observed.y)*2*-root.z/CAMERA_FOCAL-root.y,0).clampLength(0,1.5);
  translation.addScaledVector(residual,attachment);
  if(previous){
    quaternion=previous.quaternion.clone().slerp(quaternion,alpha);
    translation=previous.translation.clone().lerp(translation,alpha);
  }
  const rotated=canonical.map(v=>new THREE.Vector3(...v).applyQuaternion(quaternion));
  const e=new THREE.Matrix4().makeRotationFromQuaternion(quaternion).elements;
  const occlusionDepths=canonical.map(([x,y,z])=>{
    const side=THREE.MathUtils.smoothstep(Math.abs(x),5,7.8),rear=THREE.MathUtils.smoothstep(3.2-z,0,5);
    return e[2]*x*(1-.16*side*rear)+e[6]*y+e[10]*z;
  });
  const position=new THREE.Vector3(0,2.625+offset*6.3,5.5).applyQuaternion(quaternion).add(translation);
  return {projection:'perspective',focal:CAMERA_FOCAL,position,quaternion,translation,width:14*scale,
    metricScale:1,canonical,rotated,occlusionDepths,reprojectionError:Math.sqrt(state.cost),iterations};
}

export function trackingAlpha(previous,current,dt,aspect=1) {
  if(!previous||dt<=0)return 1;
  const size=Math.max(.05,Math.hypot((current[10].x-current[152].x)*aspect,current[10].y-current[152].y));
  let motion=0;
  for(const i of [4,6,33,263,168,10,152])motion+=Math.hypot((current[i].x-previous[i].x)*aspect,current[i].y-previous[i].y);
  const speed=motion/(7*size*dt);
  const fast=THREE.MathUtils.smoothstep(speed,.15,1.5),tau=THREE.MathUtils.lerp(.055,.008,fast);
  return 1-Math.exp(-dt/tau);
}
