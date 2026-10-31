// This lightweight helper is imported by the storefront and by retry handling.
// Calling it invokes getUserMedia synchronously within the customer's tap.
export function requestCamera(){
  if(!navigator.mediaDevices?.getUserMedia)return Promise.reject(new Error('HTTPS requis pour accéder à la caméra.'));
  const mobile=matchMedia('(max-width:750px), (hover:none) and (pointer:coarse)').matches,portrait=innerHeight>=innerWidth;
  try{return navigator.mediaDevices.getUserMedia({video:{facingMode:'user',
    width:{ideal:mobile?(portrait?720:1280):960},height:{ideal:mobile?(portrait?1280:720):720},
    ...(mobile?{resizeMode:{ideal:'none'}}:{aspectRatio:{ideal:4/3}})},audio:false});}
  catch(error){return Promise.reject(error);}
}
