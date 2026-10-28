import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// Render the shipped product, not an idealized rectangular frame. Colour its
// front, bridge and two arms independently so depth-mask regressions are visible
// in pixel coverage, including mesh self-occlusion in the unmasked reference.
const child=spawn(process.execPath,['server.js'],{
  env:{...process.env,PORT:'3195',ADMIN_PASSWORD:crypto.randomBytes(20).toString('hex')},stdio:'pipe'
});
let browser;
try {
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:3195');
  const report=await page.evaluate(async()=>{
    const THREE=await import('three');
    const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {createFaceOccluder,createHeadOccluder,updateRigidOccluders}=await import('/tryon-fit.js');
    const {estimatePerspectiveFit,projectCameraPoint,CAMERA_FOV}=await import('/tryon-perspective.js');
    const canonical=(await(await fetch('/models/canonical-face.json')).json()).vertices;
    const triangles=(await(await fetch('/models/face-topology.json')).json()).triangles;
    const gltf=await new GLTFLoader().loadAsync('/products/head-12028/head-12028-generated.glb');
    const {anchor,referenceWidth}=gltf.asset.extras.lunetteCaba;
    gltf.scene.updateMatrixWorld(true);
    const glasses=new THREE.Group(),colours=[0xff0000,0xffffff,0x00ff00,0x0000ff];
    gltf.scene.traverse(node=>{
      if(!node.isMesh)return;
      const geometry=node.geometry.clone().applyMatrix4(node.matrixWorld);
      geometry.translate(...anchor.map(v=>-v));geometry.scale(14/referenceWidth,14/referenceWidth,14/referenceWidth);geometry.translate(0,2.625,5.5);
      const indices=geometry.index.array,positions=geometry.attributes.position,parts=[[],[],[],[]];
      for(let i=0;i<indices.length;i+=3){
        const a=indices[i],b=indices[i+1],c=indices[i+2];
        const x=(positions.getX(a)+positions.getX(b)+positions.getX(c))/3;
        const y=(positions.getY(a)+positions.getY(b)+positions.getY(c))/3;
        const z=(positions.getZ(a)+positions.getZ(b)+positions.getZ(c))/3;
        const part=z>4.15?(Math.abs(x)<1.25&&y>3.35?1:0):x<0?2:3;
        parts[part].push(a,b,c);
      }
      parts.forEach((indices,i)=>{
        const part=new THREE.BufferGeometry();part.setAttribute('position',positions);part.setIndex(indices);
        glasses.add(new THREE.Mesh(part,new THREE.MeshBasicMaterial({color:colours[i],toneMapped:false,side:THREE.DoubleSide})));
      });
    });
    const scene=new THREE.Scene();scene.add(glasses);
    const faceMask=createFaceOccluder(triangles),headMask=createHeadOccluder();scene.add(faceMask,headMask);
    const camera=new THREE.PerspectiveCamera(CAMERA_FOV,1,.1,500);
    const renderer=new THREE.WebGLRenderer({antialias:false,alpha:true});renderer.setSize(480,480);
    const target=new THREE.WebGLRenderTarget(480,480);renderer.setRenderTarget(target);
    const pixels=new Uint8Array(480*480*4);
    function coverage(masked){
      faceMask.visible=headMask.visible=masked;renderer.render(scene,camera);
      renderer.readRenderTargetPixels(target,0,0,480,480,pixels);
      const result=[0,0,0,0];
      for(let i=0;i<pixels.length;i+=4){
        const r=pixels[i]>200,g=pixels[i+1]>200,b=pixels[i+2]>200;
        if(r&&g&&b)result[1]++;else if(r)result[0]++;else if(g)result[2]++;else if(b)result[3]++;
      }
      return result;
    }
    const report=[];
    for(const [name,pitch,yaw,noseVariation=0,matrixYaw=yaw] of [
      ['front',0,0],['right',0,1],['left',0,-1],['down',1,0],['up',-1.2,0],
      ['right-biased',0,.96,0,.72],['left-biased',0,-.96,0,-.72],
      ['down-nose-variation',1,0,1.2],
      ['right-down',.6,.8],['left-down',.6,-.8],['right-up',-.6,.8],['left-up',-.6,-.8]
    ]){
      const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,0));
      const translation=new THREE.Vector3(0,0,-40);
      const face=canonical.map(([x,y,z])=>{
        // A wearer is not an exact canonical face. A plausible nasal-shape
        // variation exercises the mismatch between measured XY and proxy depth.
        const nasal=(1-THREE.MathUtils.smoothstep(Math.abs(x),1,3))*THREE.MathUtils.smoothstep(y,0,2)*(1-THREE.MathUtils.smoothstep(y,5,6));
        const p=new THREE.Vector3(x,y,z+noseVariation*nasal).applyQuaternion(q).add(translation);
        return {...projectCameraPoint(p),z:0};
      });
      const reported=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,matrixYaw,0));
      const matrix={data:new THREE.Matrix4().makeRotationFromQuaternion(reported).toArray()};
      const fit=estimatePerspectiveFit(face,1,matrix,canonical);
      if(!fit)throw Error(name+': no perspective fit');
      // Geometry is already in canonical cm; production model uses the same
      // 14-cm nominal width and anchor through its normalized wrapper.
      glasses.position.copy(fit.translation);glasses.quaternion.copy(fit.quaternion);glasses.scale.setScalar(fit.metricScale);
      updateRigidOccluders(faceMask,headMask,face,1,fit);
      const reference=coverage(false),masked=coverage(true);
      report.push({name,reference,masked,retained:masked.map((n,i)=>reference[i]?n/reference[i]:null),near:yaw>0?2:3,far:yaw>0?3:2});
    }
    renderer.dispose();target.dispose();return report;
  });
  console.table(report.map(row=>({pose:row.name,
    frame:Math.round(row.retained[0]*100)+'%',bridge:Math.round(row.retained[1]*100)+'%',
    near:Math.round(row.retained[row.near]*100)+'%',far:Math.round(row.retained[row.far]*100)+'%'})));
  if(!process.env.OCCLUSION_REPORT_ONLY){
    for(const row of report){
      // From below at 69°, a perspective view lets the nose cover more of the
      // frame/bridge than an orthographic view. Lenses must remain visible;
      // forcing the bridge in front of the nose would be an occlusion error.
      assert.ok(row.retained[0]>(row.name==='up'?.8:.85),`${row.name}: frame disappeared behind the proxy`);
      if(row.name.startsWith('down'))assert.ok(row.retained[1]>.95,`${row.name}: bridge is cut by the nose proxy`);
      if(['right','left','right-biased','left-biased'].includes(row.name)){
        assert.ok(row.retained[row.near]>.9,`${row.name}: near arm is incomplete`);
        assert.ok(row.retained[row.far]<.08,`${row.name}: far arm shows through the head`);
      }
    }
    console.log('PASS: real product remains visible through pitch/yaw, bridge survives bowing, near arms remain complete and far arms are hidden.');
  }
} finally {await browser?.close();child.kill();}
