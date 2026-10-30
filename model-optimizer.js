import {fork} from 'node:child_process';
export {MODEL_OPTIMIZATION_VERSION as OPTIMIZATION_VERSION} from './public/upload-config.js';
let queue=Promise.resolve(),pending=0;

// One CPU/memory-bound job at a time. Paths originate in private staging;
// the original and the catalogue are never edited by the child process.
export function optimizeModel(input,output,{signal}={}){
  if(pending>=2)return Promise.reject(Error('Des modèles sont déjà en préparation. Réessayez dans quelques minutes.'));
  pending++;
  const job=queue.then(()=>new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('Préparation annulée.'));
    const child=fork(new URL('./scripts/optimize-model-worker.mjs',import.meta.url),[],{
      execArgv:['--max-old-space-size=512'],env:{...process.env,UV_THREADPOOL_SIZE:'1'},stdio:['ignore','ignore','pipe','ipc']
    });
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);child.kill();error?reject(error):resolve(result);};
    const cancel=()=>finish(Error('Préparation annulée.'));
    const timer=setTimeout(()=>finish(Error('La préparation du modèle a dépassé 4 minutes. Réessayez avec un GLB plus léger.')),240000);
    signal?.addEventListener('abort',cancel,{once:true});
    // Drain stderr (including native-decoder warnings), but never return raw
    // process errors, local paths, environment variables or crash dumps.
    child.stderr.on('data',()=>{});
    child.once('error',()=>finish(Error('Impossible de démarrer la préparation du modèle.')));
    child.on('message',message=>message.error?finish(Error('Optimisation impossible : '+message.error)):message.result&&finish(null,message.result));
    child.once('exit',()=>finish(Error('La préparation a été interrompue. Le modèle actuel est conservé. Essayez un GLB moins complexe.')));
    child.send({input,output});
    if(signal?.aborted)cancel();
  })).finally(()=>pending--);
  queue=job.catch(()=>{});return job;
}
