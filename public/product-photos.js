export function productPhotos(product){
  return [...new Set([product.image,...(Array.isArray(product.images)?product.images:[])].filter(value=>typeof value==='string'&&value))];
}
