import fs from 'node:fs/promises';
import path from 'node:path';
import {optimizeModel} from './model-optimizer.js';
import {validateModel} from './upload-validation.js';

export async function prepareModelUpload(file,{signal}={}){
  const source=await validateModel(file),filename=path.basename(file.filename,'.glb')+'-web.glb',output=path.join(path.dirname(file.path),filename);
  const report=await optimizeModel(file.path,output,{signal});
  const web={fieldname:'model',filename,path:output,size:report.outputBytes,originalname:file.originalname};
  await validateModel(web); // Validate the encoded GLB before any public rename.
  const files=[{...file,fieldname:'modelOriginal'},web];
  for(const extension of ['.br','.gz']){
    const candidate=output+extension;
    try{await fs.access(candidate);files.push({fieldname:'sidecar',filename:filename+extension,path:candidate});}catch{}
  }
  return {files,metadata:{...source,modelBytes:report.outputBytes,modelOriginalBytes:file.size,
    modelOriginal:'/uploads/'+file.filename,modelOptimization:report}};
}
