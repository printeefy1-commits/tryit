import {optimizeModelFile} from '../model-optimizer-core.js';
process.once('message',async({input,output})=>{
  try{process.send({result:await optimizeModelFile(input,output)},()=>process.exit(0));}
  catch(error){process.send({error:error.message},()=>process.exit(1));}
});
