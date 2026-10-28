import * as THREE from 'three';

// Freeze one decoded camera frame before inference. The detector and the
// renderer must read this same image, rather than a video that keeps advancing
// on the browser's compositor thread while CPU inference is running.
export class CameraFrame {
  constructor(width,height) {
    this.canvas=document.createElement('canvas');
    this.canvas.width=width;this.canvas.height=height;
    this.context=this.canvas.getContext('2d',{alpha:false});
    if(!this.context)throw new Error('Impossible de préparer l’image caméra.');
    this.texture=new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace=THREE.SRGBColorSpace;
    this.texture.generateMipmaps=false;
    this.texture.minFilter=THREE.LinearFilter;
    this.texture.magFilter=THREE.LinearFilter;
  }
  capture(video) {
    this.context.drawImage(video,0,0,this.canvas.width,this.canvas.height);
    this.texture.needsUpdate=true;
    return this.canvas;
  }
  dispose() {
    this.texture.dispose();
    this.canvas.width=1;this.canvas.height=1;
  }
}
