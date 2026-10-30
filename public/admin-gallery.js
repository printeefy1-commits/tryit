import {IMAGE_MAX_BYTES,PHOTO_MAX_COUNT} from './upload-config.js';
import {productPhotos} from './product-photos.js';

export class PhotoGallery{
  constructor(onChange,onError){this.entries=[];this.onChange=onChange;this.onError=onError;this.version=0;}
  get blocked(){return this.entries.some(entry=>entry.invalid||entry.pending);}
  reset(product){
    for(const entry of this.entries)if(entry.file)URL.revokeObjectURL(entry.src);
    this.entries=product?productPhotos(product).map((src,index)=>({key:src,src,name:'Photo '+(index+1)})):[];
    this.viewed=this.entries[0]?.key;this.render();
  }
  add(files){
    if(this.entries.length+files.length>PHOTO_MAX_COUNT){this.onError('Vous pouvez ajouter jusqu’à 10 photos par produit.');return;}
    for(const file of files)if(!file.size||file.size>IMAGE_MAX_BYTES||!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)){this.onError(file.name+' : choisissez une photo JPG, PNG, WebP ou HEIC de 10 Mo maximum.');return;}
    this.onError('');
    for(const file of files)this.entries.push({key:crypto.randomUUID(),src:URL.createObjectURL(file),name:file.name,file,heic:/\.hei[cf]$/i.test(file.name),pending:true});
    this.viewed||=this.entries[0]?.key;this.render();
  }
  remove(key){
    const entry=this.entries.find(e=>e.key===key);if(entry?.file)URL.revokeObjectURL(entry.src);
    this.entries=this.entries.filter(e=>e.key!==key);if(this.viewed===key)this.viewed=this.entries[0]?.key;this.render();
  }
  primary(key){
    const index=this.entries.findIndex(e=>e.key===key);if(index<0)return;
    this.entries.unshift(this.entries.splice(index,1)[0]);this.viewed=key;this.render();
  }
  invalid(entry){
    if(entry.invalid||!this.entries.includes(entry))return;entry.invalid=true;entry.pending=false;
    this.onError(entry.name+' : la photo est illisible. Retirez-la ou choisissez un autre fichier.');this.render();
  }
  show(entry){
    const version=++this.version,img=document.querySelector('#photo-preview'),placeholder=document.querySelector('#photo-placeholder');
    if(!entry||entry.invalid){img.hidden=true;img.removeAttribute('src');placeholder.hidden=false;placeholder.textContent=entry?'Photo illisible · retirez-la de la sélection.':'Vos photos apparaîtront ici';return;}
    img.src=entry.src;img.hidden=false;placeholder.hidden=true;
    img.decode().catch(()=>{if(version!==this.version)return;img.hidden=true;placeholder.hidden=false;if(entry.heic)placeholder.textContent='Photo HEIC sélectionnée · conversion en JPG à l’enregistrement.';else this.invalid(entry);});
  }
  render(){
    const list=document.querySelector('#photo-gallery');list.replaceChildren();
    for(const [index,entry] of this.entries.entries()){
      const tile=document.createElement('div');tile.className='admin-photo-tile'+(entry.invalid?' photo-invalid':'');tile.dataset.photoKey=entry.key;
      const view=document.createElement('button');view.type='button';view.className='gallery-preview';view.setAttribute('aria-label','Aperçu de la photo '+(index+1));view.setAttribute('aria-pressed',String(this.viewed===entry.key));
      const fallback=document.createElement('span');fallback.textContent=entry.invalid?'Photo illisible':entry.heic?'HEIC':'Photo';view.append(fallback);
      if(!entry.invalid){
        const img=document.createElement('img');img.alt='';img.src=entry.src;
        img.onload=()=>{if(!this.entries.includes(entry))return;entry.pending=false;fallback.hidden=true;this.onChange();};
        img.onerror=()=>{img.hidden=true;entry.pending=false;if(entry.heic)this.onChange();else this.invalid(entry);};view.append(img);
      }
      view.onclick=()=>{this.viewed=entry.key;this.render();};
      const title=document.createElement('span');title.className='gallery-name';title.textContent=entry.name;title.title=entry.name;
      const primary=document.createElement('button');primary.type='button';primary.className='make-primary';primary.textContent=index===0?'Photo principale':'Définir principale';primary.disabled=index===0;primary.onclick=()=>this.primary(entry.key);
      const remove=document.createElement('button');remove.type='button';remove.className='remove-photo';remove.textContent='×';remove.setAttribute('aria-label','Retirer la photo '+(index+1));remove.onclick=()=>this.remove(entry.key);
      tile.append(view,remove,title,primary);list.append(tile);
    }
    document.querySelector('#image-file-meta').textContent=this.entries.length?`${this.entries.length} / ${PHOTO_MAX_COUNT} photos · la première est la photo principale.`:'Aucune photo sélectionnée.';
    this.show(this.entries.find(e=>e.key===this.viewed)||this.entries[0]);this.onChange();
  }
  appendTo(data){
    data.delete('image');let next=0;
    const order=this.entries.map(entry=>{if(!entry.file)return entry.src;data.append('image',entry.file,entry.file.name);return 'new:'+next++;});
    data.set('photoOrder',JSON.stringify(order));
  }
}
