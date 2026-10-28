import * as THREE from 'three';

const SOURCE_SHA='20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055';
export const HEAD_MEASUREMENTS=Object.freeze({reportedSpanMm:110,endpoints:'owner-described bridge-to-bridge span; exterior width not established',calibrated:false});

function hull(points) {
  const sorted=points.sort((a,b)=>a.x-b.x||a.y-b.y),lower=[],upper=[];
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(const p of sorted){while(lower.length>1&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
  for(const p of sorted.slice().reverse()){while(upper.length>1&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
  return lower.slice(0,-1).concat(upper.slice(0,-1));
}
function inside(point,polygon) {
  return polygon.length>=3&&polygon.every((a,i)=>{
    const b=polygon[(i+1)%polygon.length];return (b.x-a.x)*(point.y-a.y)-(b.y-a.y)*(point.x-a.x)>=-1e-6;
  });
}

// This is a profile of the owner's known generated mesh, not a classifier for
// arbitrary uploads. The fused AI asset has opaque photographed lens colours
// and a baked normal map. Recover its lens triangles so camera pixels can show
// through separate optical materials instead of a painted grey surface.
export function prepareKnownMaterials(gltf) {
  const profile=gltf.asset?.extras?.lunetteCaba;
  if(profile?.sourceSha256!==SOURCE_SHA)return null;
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
    if(!uv||!index)return;
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
      const lens=aperture(center)&&inside(center,outlines[center.x<0?0:1]);
      (lens?lenses:frame).push(...ids);
    }
    // Reject a wrong profile instead of silently replacing an entire frame.
    const fraction=lenses.length/index.count;
    if(fraction<.1||fraction>.8)return;
    lensTriangles+=lenses.length/3;frameTriangles+=frame.length/3;
    for(const ids of seeds)for(const id of ids)bounds[vertices[id].point.x<0?0:1].expandByPoint(vertices[id].point);
    const geometry=original.clone();geometry.setIndex([...frame,...lenses]);geometry.clearGroups();
    geometry.addGroup(0,frame.length,0);geometry.addGroup(frame.length,lenses.length,1);
    const frameMaterial=new THREE.MeshPhysicalMaterial({
      name:'HEAD 12028 — estimated navy acetate, no baked AI highlights',color:0x101b28,
      metalness:.02,roughness:.24,clearcoat:1,clearcoatRoughness:.12,envMapIntensity:.65
    });
    const lensMaterial=new THREE.MeshPhysicalMaterial({
      name:'HEAD 12028 — separate estimated blue-grey optical surface',color:0x22333c,
      metalness:0,roughness:.12,clearcoat:1,clearcoatRoughness:.08,
      transparent:true,opacity:.68,depthWrite:false,side:THREE.FrontSide,envMapIntensity:.45
    });
    mesh.geometry=geometry;const oldMaterial=mesh.material;mesh.material=[frameMaterial,lensMaterial];
    original.dispose();
    for(const value of Object.values(oldMaterial))if(value?.isTexture)value.dispose();
    oldMaterial.dispose();
    textureCanvas.width=textureCanvas.height=1;
  });
  if(bounds.some(b=>b.isEmpty()))return null;
  const widths=bounds.map(b=>b.max.x-b.min.x),apertureWidth=(widths[0]+widths[1])/2;
  // Neither the printed example nor an ambiguously measured 11-cm span is a
  // verified exterior front width. The admin can enter that measurement later.
  return {measurements:HEAD_MEASUREMENTS,lensTriangles,frameTriangles,
    frameWidthCm:14,
    derivedApertureWidthCm:apertureWidth,estimated:true};
}
