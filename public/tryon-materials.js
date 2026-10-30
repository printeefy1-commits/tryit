import * as THREE from 'three';
import {knownModelProfile} from './tryon-model-profiles.js';

export const HEAD_MEASUREMENTS=Object.freeze({reportedSpanMm:110,endpoints:'owner-described bridge-to-bridge span; exterior width not established',calibrated:false});

function hull(points) {
  const sorted=points.sort((a,b)=>a.x-b.x||a.y-b.y),lower=[],upper=[];
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(const p of sorted){while(lower.length>1&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
  for(const p of sorted.slice().reverse()){while(upper.length>1&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
  return lower.slice(0,-1).concat(upper.slice(0,-1));
}
function inside(point,polygon,margin=0) {
  return polygon.length>=3&&polygon.every((a,i)=>{
    const b=polygon[(i+1)%polygon.length];return (b.x-a.x)*(point.y-a.y)-(b.y-a.y)*(point.x-a.x)>=-1e-6-margin*Math.hypot(b.x-a.x,b.y-a.y);
  });
}

function prepareAuthoredMaterials(gltf,known){
  if(gltf.scene.userData.authoredMaterialsPrepared)return null;
  const meshes=[];gltf.scene.traverse(mesh=>{if(mesh.isMesh)meshes.push(mesh);});
  if(meshes.some(mesh=>Array.isArray(mesh.material)||!['frame','Blue_Lenses'].includes(mesh.material.name)||!mesh.geometry.index))return null;
  const frame=meshes.find(mesh=>mesh.material.name==='frame')?.material;
  const lenses=meshes.find(mesh=>mesh.material.name==='Blue_Lenses')?.material;
  if(!frame||!lenses)return null;
  let frameTriangles=0,lensTriangles=0;
  // The owner already separated and coloured these surfaces. Keep their
  // materials, vertex colours, opacity and normals exactly as loaded. Only
  // standardize the material groups used by the fitting/visibility controller.
  for(const mesh of meshes){
    const lens=mesh.material.name==='Blue_Lenses',count=mesh.geometry.index.count;
    mesh.geometry.clearGroups();mesh.geometry.addGroup(0,count,lens?1:0);
    mesh.material=[frame,lenses];
    if(lens)lensTriangles+=count/3;else frameTriangles+=count/3;
  }
  gltf.scene.userData.authoredMaterialsPrepared=true;
  return {measurements:known.measurements,lensTriangles,frameTriangles,frameWidthCm:14,estimated:true,authoredMaterials:true};
}

// Profiles of the owner's reviewed generated meshes, not arbitrary uploads. Keep
// its source colours/markings, separate its optical shading from the frame,
// and replace noisy generated lens normals with a coherent curved surface.
export function prepareKnownMaterials(gltf) {
  const profile=gltf.asset?.extras?.lunetteCaba;
  const known=knownModelProfile(gltf);
  if(!known)return null;
  if(!Array.isArray(profile.anchor)||profile.anchor.length!==3||!profile.anchor.every(Number.isFinite)
    ||!Number.isFinite(profile.referenceWidth)||profile.referenceWidth<=0)return null;
  if(known.authoredMaterials)return prepareAuthoredMaterials(gltf,known);
  const anchor=new THREE.Vector3(...profile.anchor),point=new THREE.Vector3();
  const bounds=[new THREE.Box3(),new THREE.Box3()];
  let lensTriangles=0,frameTriangles=0;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh=>{
    if(!mesh.isMesh||Array.isArray(mesh.material)||!mesh.material.map)return;
    const image=mesh.material.map.image,textureCanvas=document.createElement('canvas');
    textureCanvas.width=image.width;textureCanvas.height=image.height;
    const context=textureCanvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,image.width,image.height).data;
    const original=mesh.geometry,positions=original.attributes.position,uv=original.attributes.uv,index=original.index;
    if(!uv||!index||!original.attributes.normal)return;
    const frame=[],lenses=[],seeds=[new Set(),new Set()],triangles=[];
    const data=i=>{
      point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).sub(anchor).multiplyScalar(14/profile.referenceWidth);
      const x=THREE.MathUtils.clamp(Math.floor(uv.getX(i)*image.width),0,image.width-1);
      const y=THREE.MathUtils.clamp(Math.floor(uv.getY(i)*image.height),0,image.height-1),p=(y*image.width+x)*4;
      return {point:point.clone(),light:.2126*pixels[p]+.7152*pixels[p+1]+.0722*pixels[p+2]};
    };
    const vertices=Array.from({length:positions.count},(_,i)=>data(i));
    const aperture=center=>center.z>-.105*14&&Math.abs(center.x)>.65&&Math.abs(center.x)<6.6
      &&center.y> -2.3&&center.y<2.25;
    for(let i=0;i<index.count;i+=3){
      const ids=[index.getX(i),index.getX(i+1),index.getX(i+2)],corners=ids.map(i=>vertices[i]);
      const center=corners.reduce((sum,v)=>sum.add(v.point),new THREE.Vector3()).multiplyScalar(1/3);
      triangles.push({ids,center});
      if(aperture(center)&&corners.every(v=>v.light>32))for(const id of ids)seeds[center.x<0?0:1].add(id);
    }
    // Fill baked dark reflections/lettering inside the aperture. A per-texel
    // alpha threshold alone leaves opaque islands in the middle of a lens.
    const outlines=seeds.map(ids=>hull([...ids].map(i=>vertices[i].point)));
    for(const {ids,center} of triangles){
      const outline=outlines[center.x<0?0:1],bright=ids.reduce((sum,i)=>sum+vertices[i].light,0)/3>32;
      const lens=aperture(center)&&(inside(center,outline)||(bright&&inside(center,outline,.08)));
      (lens?lenses:frame).push(...ids);
    }
    // Reject a wrong profile instead of silently replacing an entire frame.
    const fraction=lenses.length/index.count;
    if(fraction<.1||fraction>.8)return;
    lensTriangles+=lenses.length/3;frameTriangles+=frame.length/3;
    for(const ids of seeds)for(const id of ids)bounds[vertices[id].point.x<0?0:1].expandByPoint(vertices[id].point);
    // Give optical vertices their own normals. Sharing a rim vertex with a
    // noisy generated lens changes the rim shading or leaves faceted patches.
    const geometry=original.clone(),lensIds=[...new Set(lenses)],duplicates=new Map(lensIds.map((id,i)=>[id,positions.count+i]));
    for(const [name,attribute] of Object.entries(original.attributes)){
      const values=new attribute.array.constructor((attribute.count+lensIds.length)*attribute.itemSize);
      values.set(attribute.array);
      lensIds.forEach((id,i)=>{for(let j=0;j<attribute.itemSize;j++)values[(attribute.count+i)*attribute.itemSize+j]=attribute.array[id*attribute.itemSize+j];});
      geometry.setAttribute(name,new THREE.BufferAttribute(values,attribute.itemSize,attribute.normalized));
    }
    const normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),inverseNormal=normalMatrix.clone().invert();
    const centres=outlines.map(points=>new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()));
    for(const id of lensIds){
      const p=vertices[id].point,centre=centres[p.x<0?0:1];
      const normal=new THREE.Vector3((p.x-centre.x)*.035,(p.y-centre.y)*.035,1)
        .applyMatrix3(inverseNormal).normalize();
      geometry.attributes.normal.setXYZ(duplicates.get(id),normal.x,normal.y,normal.z);
    }
    geometry.setIndex([...frame,...lenses.map(id=>duplicates.get(id))]);geometry.clearGroups();
    geometry.addGroup(0,frame.length,0);geometry.addGroup(frame.length,lenses.length,1);
    const sourceColour=mesh.material.map;
    const frameMaterial=new THREE.MeshPhysicalMaterial({
      name:known.label+' — original frame colour and markings',color:mesh.material.color.clone(),map:sourceColour,
      metalness:0,roughness:.55,clearcoat:.1,clearcoatRoughness:.4,envMapIntensity:.3,
      side:known.frameDoubleSided?THREE.DoubleSide:THREE.FrontSide
    });
    const lensMaterial=new THREE.MeshPhysicalMaterial({
      name:known.label+' — original lens colour with smooth optical normals',color:mesh.material.color.clone(),map:sourceColour,
      metalness:0,roughness:.18,clearcoat:.8,clearcoatRoughness:.16,
      transparent:true,opacity:.96,depthWrite:false,side:THREE.FrontSide,envMapIntensity:.35
    });
    mesh.geometry=geometry;const oldMaterial=mesh.material;mesh.material=[frameMaterial,lensMaterial];
    original.dispose();
    for(const value of Object.values(oldMaterial))if(value?.isTexture&&value!==sourceColour)value.dispose();
    oldMaterial.dispose();
    textureCanvas.width=textureCanvas.height=1;
  });
  if(bounds.some(b=>b.isEmpty()))return null;
  const widths=bounds.map(b=>b.max.x-b.min.x),apertureWidth=(widths[0]+widths[1])/2;
  // Neither the printed example nor an ambiguously measured 11-cm span is a
  // verified exterior front width. The admin can enter that measurement later.
  return {measurements:known.measurements,lensTriangles,frameTriangles,
    frameWidthCm:14,
    derivedApertureWidthCm:apertureWidth,estimated:true};
}
