// Real geometry with an unused padded BIN region: tests the >25-MiB path
// without forcing software WebGL to render millions of triangles.
export function uploadModelFixture(original,minimumBinaryBytes=26*1024*1024,edit=()=>{}){
  const length=original.readUInt32LE(12),doc=JSON.parse(original.subarray(20,20+length));
  const binary=original.subarray(28+length),target=Math.max(binary.length,minimumBinaryBytes);
  delete doc.asset.extras; // Exercise automatic fitting for an unknown upload.
  doc.buffers[0].byteLength=target;
  edit(doc);
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+target,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(target,0);binHeader.writeUInt32LE(0x004e4942,4);
  const payload=Buffer.alloc(target);binary.copy(payload);
  return Buffer.concat([header,json,binHeader,payload]);
}
