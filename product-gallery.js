import {productPhotos} from './public/product-photos.js';
import {PHOTO_MAX_COUNT} from './public/upload-config.js';

export function parsePhotoOrder(value){
  if(value===undefined)return undefined;
  let order;try{order=typeof value==='string'?JSON.parse(value):value;}catch{throw Error('La sélection de photos est invalide.');}
  if(!Array.isArray(order)||order.length>PHOTO_MAX_COUNT||order.some(key=>typeof key!=='string')||new Set(order).size!==order.length)throw Error('La sélection de photos est invalide (10 photos maximum).');
  return order;
}

export function planPhotos(product,files,order){
  if(order===undefined)return files.length?files.map(file=>'/uploads/'+file.filename):undefined;
  const existing=new Set(productPhotos(product)),used=new Set();
  const result=order.map(key=>{
    if(existing.has(key))return key;
    if(!/^new:(0|[1-9]\d*)$/.test(key))throw Error('Cette photo ne fait pas partie du produit.');
    const index=Number(key.slice(4));if(!files[index])throw Error('Une photo sélectionnée est manquante.');
    used.add(index);return '/uploads/'+files[index].filename;
  });
  if(used.size!==files.length)throw Error('La sélection de photos ne correspond pas aux fichiers envoyés.');
  return result;
}
