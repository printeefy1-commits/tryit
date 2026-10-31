export function productPhotos(product){
  return [...new Set([product.image,...(Array.isArray(product.images)?product.images:[])].filter(value=>typeof value==='string'&&value))];
}

// Keep original references for administration and gallery ordering. Only the
// storefront's presentation URLs point at resized, cached derivatives.
export function productImage(src,size=800){
  if(typeof src!=='string'||![128,800,1600].includes(size)
    ||!/^\/(uploads|products)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:jpe?g|png|webp)$/i.test(src)
    ||src.split('/').some(part=>part==='.'||part==='..'))return src;
  return `/product-images/v1/${size}?src=${encodeURIComponent(src)}`;
}

// Density descriptors avoid claiming an exact intrinsic width when a small
// original is intentionally not enlarged. Both candidates keep its aspect.
export function productImageSet(src,sizes=[800,1600]){
  const valid=sizes.filter(size=>[128,800,1600].includes(size));
  if(!valid.length||productImage(src,valid[0])===src)return '';
  return valid.map(size=>`${productImage(src,size)} ${size/valid[0]}x`).join(', ');
}

export function displayProductImage(image,src,size=800){
  image.onerror=()=>{image.onerror=null;image.removeAttribute('srcset');image.src=src;};
  if(size===800)image.srcset=productImageSet(src);else image.removeAttribute('srcset');
  image.src=productImage(src,size);
}
