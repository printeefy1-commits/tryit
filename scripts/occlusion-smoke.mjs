import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// Render the shipped product, not an idealized rectangular frame. Colour its
// front, bridge, straight temples and curved tips independently so depth-mask
// regressions are visible, including self-occlusion in the unmasked reference.
// A tip can correctly disappear behind the head before the visible temple does.
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
  const report=await page.evaluate(async(modelUrl)=>{
    const THREE=await import('three');
    const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const {createFaceOccluder,createHeadOccluder,updateRigidOccluders,cameraDirectionInHead}=await import('/tryon-fit.js');
    const {createEarOccluders,updateEarOccluders,prepareKnownTempleFit}=await import('/tryon-ears.js');
    const {prepareKnownMaterials}=await import('/tryon-materials.js');
    const {estimatePerspectiveFit,projectCameraPoint,CAMERA_FOV}=await import('/tryon-perspective.js');
    const canonical=(await(await fetch('/models/canonical-face.json')).json()).vertices;
    const triangles=(await(await fetch('/models/face-topology.json')).json()).triangles;
    const gltf=await new GLTFLoader().loadAsync(modelUrl);
    prepareKnownMaterials(gltf);
    prepareKnownTempleFit(gltf);
    const {anchor,referenceWidth}=gltf.asset.extras.lunetteCaba;
    gltf.scene.updateMatrixWorld(true);
    const glasses=new THREE.Group(),colours=[0xff0000,0xffffff,0x00ff00,0x0000ff,0xffff00,0x00ffff];
    gltf.scene.traverse(node=>{
      if(!node.isMesh)return;
      const geometry=node.geometry.clone().applyMatrix4(node.matrixWorld);
      geometry.translate(...anchor.map(v=>-v));geometry.scale(14/referenceWidth,14/referenceWidth,14/referenceWidth);geometry.translate(0,2.625,5.5);
      const indices=geometry.index.array,positions=geometry.attributes.position,parts=[[],[],[],[],[],[]];
      for(let i=0;i<indices.length;i+=3){
        const a=indices[i],b=indices[i+1],c=indices[i+2];
        const x=(positions.getX(a)+positions.getX(b)+positions.getX(c))/3;
        const y=(positions.getY(a)+positions.getY(b)+positions.getY(c))/3;
        const z=(positions.getZ(a)+positions.getZ(b)+positions.getZ(c))/3;
        const part=z>4.15?(Math.abs(x)<1.25&&y>3.35?1:0):z< -4.5?(x<0?4:5):x<0?2:3;
        parts[part].push(a,b,c);
      }
      parts.forEach((indices,i)=>{
        const part=new THREE.BufferGeometry();part.setAttribute('position',positions);part.setIndex(indices);
        glasses.add(new THREE.Mesh(part,new THREE.MeshBasicMaterial({color:colours[i],toneMapped:false,side:THREE.DoubleSide})));
      });
    });
    const scene=new THREE.Scene();scene.add(glasses);
    const faceMask=createFaceOccluder(triangles),headMask=createHeadOccluder();scene.add(faceMask,headMask);
    const earMasks=createEarOccluders();scene.add(earMasks);
    const camera=new THREE.PerspectiveCamera(CAMERA_FOV,1,.1,500);
    const renderer=new THREE.WebGLRenderer({antialias:false,alpha:true});renderer.setSize(480,480);
    const target=new THREE.WebGLRenderTarget(480,480);renderer.setRenderTarget(target);
    const pixels=new Uint8Array(480*480*4);
    // Put an independent surface just behind the actual nasal ridge, rather
    // than only counting total frame pixels (which misses nose show-through).
    const probe=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4),new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));
    probe.visible=false;scene.add(probe);
    const skin=createFaceOccluder(triangles),ray=new THREE.Raycaster();
    function nasalCoverage(face,fit,index,masked){
      // Sample a pixel centre, not an exact silhouette vertex. At a grazing
      // angle half a raster pixel can lie on a different side of the nose.
      const centreX=Math.floor(face[index].x*480),centreY=Math.floor((1-face[index].y)*480);
      const positions=skin.geometry.attributes.position;
      for(let i=0;i<468;i++){
        const z=fit.rotated[i].z+fit.translation.z;
        positions.setXYZ(i,(face[i].x-.5)*2*-z/fit.focal,(.5-face[i].y)*2*-z/fit.focal,z);
      }
      skin.geometry.computeBoundingSphere();skin.updateMatrixWorld(true);
      let sample;
      const offsets=[];for(let dx=-3;dx<=3;dx++)for(let dy=-3;dy<=3;dy++)offsets.push({dx,dy});
      offsets.sort((a,b)=>a.dx*a.dx+a.dy*a.dy-b.dx*b.dx-b.dy*b.dy);
      for(const {dx,dy} of offsets){
        const px=centreX+dx,py=centreY+dy,x=(px+.5)/240-1,y=(py+.5)/240-1;
        ray.setFromCamera(new THREE.Vector2(x,y),camera);
        const surface=ray.intersectObject(skin)[0];
        if(surface&&Math.abs(surface.face.normal.z)>.2&&[surface.face.a,surface.face.b,surface.face.c].every(i=>Math.abs(canonical[i][0])<1.5)){
          sample={px,py,x,y,surface};break;
        }
      }
      if(!sample)throw Error('No exposed nasal skin near landmark '+index);
      const {px,py,x,y,surface}=sample;
      const depth=surface.point.z-.4;
      probe.position.set(x*-depth/fit.focal,y*-depth/fit.focal,depth);
      probe.visible=true;glasses.visible=false;faceMask.visible=headMask.visible=masked;
      earMasks.visible=masked;
      renderer.render(scene,camera);
      const pixel=new Uint8Array(4);
      renderer.readRenderTargetPixels(target,px,py,1,1,pixel);
      probe.visible=false;glasses.visible=true;
      return pixel[3]>200;
    }
    function coverage(masked){
      faceMask.visible=!!masked&&masked!=='head';headMask.visible=!!masked&&masked!=='face';
      earMasks.visible=masked===true;
      renderer.render(scene,camera);
      renderer.readRenderTargetPixels(target,0,0,480,480,pixels);
      const result=[0,0,0,0,0,0];
      for(let i=0;i<pixels.length;i+=4){
        const r=pixels[i]>200,g=pixels[i+1]>200,b=pixels[i+2]>200;
        if(r&&g&&b)result[1]++;else if(r&&g)result[4]++;else if(g&&b)result[5]++;
        else if(r)result[0]++;else if(g)result[2]++;else if(b)result[3]++;
      }
      return result;
    }
    function surfaceVisibility(local,fit,masked){
      probe.position.set(...local).applyQuaternion(fit.quaternion).multiplyScalar(fit.metricScale).add(fit.translation);
      probe.visible=true;glasses.visible=false;faceMask.visible=headMask.visible=earMasks.visible=masked;
      const screen=projectCameraPoint(probe.position),pixel=new Uint8Array(4);
      renderer.render(scene,camera);
      renderer.readRenderTargetPixels(target,Math.floor(screen.x*480),Math.floor((1-screen.y)*480),1,1,pixel);
      probe.visible=false;glasses.visible=true;return pixel[3]>200;
    }
    const report=[];
    for(const [name,pitch,yaw,noseVariation=0,matrixYaw=yaw,roll=0,templeWidth=1,depth=-40,tx=0,ty=0] of [
      ['front',0,0],['right',0,1],['left',0,-1],['down',1,0],['up',-1.2,0],
      ['right-biased',0,.96,0,.72],['left-biased',0,-.96,0,-.72],
      ['down-nose-variation',1,0,1.2],
      ['right-down',.6,.8],['left-down',.6,-.8],['right-up',-.6,.8],['left-up',-.6,-.8],
      ['right-roll',.3,.45,0,.45,.55],['left-roll',.3,-.45,0,-.45,-.55],
      ['right-close-wide',.2,.45,0,.45,.4,1.15,-32],['left-close-wide',.2,-.45,0,-.45,-.4,1.15,-32],
      ['mild-off-centre-left',-.067,.159,0,.159,.55,1,-40,-8,-2],
      ['mild-off-centre-right',-.067,-.159,0,-.159,-.55,1,-40,8,-2],
      ['bow-off-centre',.45,.08,0,.08,0,1,-38,-3,-7],
      ['bow-tip-left',.5,-.4,0,-.4,-.3,1,-38,0,-4],
      ['bow-tip-right',.5,.4,0,.4,.3,1,-38,0,-4]
    ]){
      const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,yaw,roll));
      const translation=new THREE.Vector3(tx,ty,depth);
      const face=canonical.map(([x,y,z])=>{
        // A wearer is not an exact canonical face. A plausible nasal-shape
        // variation exercises the mismatch between measured XY and proxy depth.
        const nasal=(1-THREE.MathUtils.smoothstep(Math.abs(x),1,3))*THREE.MathUtils.smoothstep(y,0,2)*(1-THREE.MathUtils.smoothstep(y,5,6));
        const width=1+(templeWidth-1)*THREE.MathUtils.smoothstep(Math.abs(x),3,6);
        const p=new THREE.Vector3(x*width,y,z+noseVariation*nasal).applyQuaternion(q).add(translation);
        return {...projectCameraPoint(p),z:0};
      });
      const reported=new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch,matrixYaw,roll));
      const matrix={data:new THREE.Matrix4().makeRotationFromQuaternion(reported).toArray()};
      const fit=estimatePerspectiveFit(face,1,matrix,canonical);
      if(!fit)throw Error(name+': no perspective fit');
      // Geometry is already in canonical cm; production model uses the same
      // 14-cm nominal width and anchor through its normalized wrapper.
      glasses.position.copy(fit.translation);glasses.quaternion.copy(fit.quaternion);glasses.scale.setScalar(fit.metricScale);
      updateRigidOccluders(faceMask,headMask,face,1,fit);
      updateEarOccluders(earMasks,fit);
      const reference=coverage(false),masked=coverage(true);
      const faceOnly=coverage('face'),headOnly=coverage('head');
      const view=cameraDirectionInHead(fit);
      const nasalIndices=view.y<.25?[4,6,197]:[4];
      const nasalProbes=templeWidth===1?nasalIndices.map(index=>({index,
        unmasked:nasalCoverage(face,fit,index,false),masked:nasalCoverage(face,fit,index,true)})):[];
      const scalpProbes=[];
      if(view.y>.55&&Math.abs(view.x)<.2)for(const side of [-1,1]){
        // In an oblique bow the near shaft has an outside route to the ear;
        // the far shaft must remain behind the scalp. Frontal bows hide both.
        if(Math.abs(view.x)>.08&&side*view.x>0)continue;
        const local=[side*7.4,4.4,-4];
        scalpProbes.push({side,unmasked:surfaceVisibility(local,fit,false),masked:surfaceVisibility(local,fit,true)});
      }
      if(name.startsWith('bow-tip')){
        const side=view.x<0?1:-1,local=[side*7,4,-5];
        scalpProbes.push({side,unmasked:surfaceVisibility(local,fit,false),masked:surfaceVisibility(local,fit,true)});
      }
      report.push({name,view:view.toArray(),reference,masked,faceOnly,headOnly,nasalProbes,scalpProbes,retained:masked.map((n,i)=>reference[i]?n/reference[i]:null),near:view.x<0?2:3,far:view.x<0?3:2});
    }
    renderer.dispose();target.dispose();return report;
  },process.env.TRYON_MODEL_URL||'/products/head-12028/head-12028-generated.glb');
  console.table(report.map(row=>({pose:row.name,
    frame:Math.round(row.retained[0]*100)+'%',bridge:Math.round(row.retained[1]*100)+'%',
    near:Math.round(row.retained[row.near]*100)+'%',far:Math.round(row.retained[row.far]*100)+'%'})));
  if(process.env.OCCLUSION_REPORT_ONLY)console.log(JSON.stringify(report.filter(r=>r.name.includes('roll')||r.name.includes('wide')||r.name.startsWith('mild')||r.scalpProbes.length||r.nasalProbes.some(p=>p.masked)),null,2));
  if(!process.env.OCCLUSION_REPORT_ONLY){
    for(const row of report){
      // From below at 69°, a perspective view lets the nose cover more of the
      // frame/bridge than an orthographic view. Lenses must remain visible;
      // forcing the bridge in front of the nose would be an occlusion error.
      // The nose correctly covers some of the far lens when looking up and
      // sideways. Its independent probes below distinguish that from an
      // oversized proxy hiding the entire frame.
      assert.ok(row.retained[0]>(row.name.includes('up')?.8:.85),`${row.name}: frame disappeared behind the proxy`);
      if(row.name.startsWith('down'))assert.ok(row.retained[1]>.95,`${row.name}: bridge is cut by the nose proxy`);
      for(const probe of row.nasalProbes){
        assert.ok(probe.unmasked,`${row.name}: nasal probe ${probe.index} is outside the view`);
        assert.equal(probe.masked,false,`${row.name}: surface behind the nose shows through skin at ${probe.index}`);
      }
      for(const probe of row.scalpProbes){
        assert.ok(probe.unmasked,`${row.name}: scalp reference is outside the view`);
        assert.equal(probe.masked,false,`${row.name}: rear temple shows through the upper scalp on side ${probe.side}`);
      }
      if(row.name.startsWith('mild-off-centre'))assert.ok(row.masked[row.near]>25,`${row.name}: near shaft is hidden by the front rim`);
      if(row.name.startsWith('right')||row.name.startsWith('left')){
        // A raised rear shaft can legitimately be behind the scalp when seen
        // from above; complete visibility is required in level side views.
        if(row.view[1]<.3)assert.ok(row.retained[row.near]>.9,`${row.name}: near arm is incomplete`);
        if(['right','left','right-biased','left-biased'].includes(row.name))assert.ok(row.retained[row.far]<.08,`${row.name}: far arm shows through the head`);
      }
    }
    console.log('PASS: nose/scalp hide surfaces behind them, bowing preserves the bridge, level side views retain near shafts, and mild off-centre views show the opened temples.');
  }
} finally {await browser?.close();child.kill();}
