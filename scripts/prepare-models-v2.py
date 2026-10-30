import bpy,math,json,struct,time,sys,argparse,hashlib
from pathlib import Path
from mathutils import Vector
parser=argparse.ArgumentParser(description='Prepare the owner-supplied models-v2 for browser try-on; requires Blender 4.3.')
parser.add_argument('--input',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
source=args.input.resolve()
output=args.output.resolve()
output.parent.mkdir(parents=True,exist_ok=True)
source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
expected='046f50c9b51e6d12d0956db2d60a4b0566c6d0455e5f2a374d8af939b198e0bf'
if source_hash!=expected:raise RuntimeError('This fitting profile applies only to the verified models-v2 source asset.')
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
original=sum(len(o.data.polygons) for o in meshes)
print('Imported faces',original,flush=True)
for ob in meshes:
 bpy.context.view_layer.objects.active=ob
 bpy.ops.object.select_all(action='DESELECT');ob.select_set(True)
 budget=max(4,round(75000*len(ob.data.polygons)/original))
 if len(ob.data.polygons)>budget:
  dec=ob.modifiers.new('Mobile mesh simplification','DECIMATE');dec.ratio=budget/len(ob.data.polygons);dec.use_collapse_triangulate=True
  bpy.ops.object.modifier_apply(modifier=dec.name)
 print('Optimized faces',len(ob.data.polygons),flush=True)
for image in bpy.data.images:
 if image.type=='IMAGE' and max(image.size)>2048:
  w,h=image.size;scale=2048/max(w,h);image.scale(round(w*scale),round(h*scale));image.pack();print('Scaled texture',image.name,tuple(image.size),flush=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',export_yup=True,export_apply=True,export_materials='EXPORT',export_image_format='AUTO',export_tangents=True)
print('Output',output.stat().st_size,'bytes',flush=True)

raw=bytearray(output.read_bytes())
size,kind=struct.unpack_from('<II',raw,12)
doc=json.loads(raw[20:20+size])
# A collapsed UV triangle can yield a zero MikkTSpace tangent. Use a stable
# perpendicular to its vertex normal for these undefined derivatives only.
binary_start=20+size+8
repaired=0
for mesh in doc['meshes']:
 for primitive in mesh['primitives']:
  if 'TANGENT' not in primitive['attributes']:continue
  tangent=doc['accessors'][primitive['attributes']['TANGENT']]
  normal=doc['accessors'][primitive['attributes']['NORMAL']]
  tv=doc['bufferViews'][tangent['bufferView']]
  nv=doc['bufferViews'][normal['bufferView']]
  assert tangent['componentType']==5126 and normal['componentType']==5126
  for i in range(tangent['count']):
   ti=binary_start+tv.get('byteOffset',0)+tangent.get('byteOffset',0)+i*tv.get('byteStride',16)
   x,y,z,w=struct.unpack_from('<4f',raw,ti)
   if x*x+y*y+z*z<1e-12:
    ni=binary_start+nv.get('byteOffset',0)+normal.get('byteOffset',0)+i*nv.get('byteStride',12)
    n=Vector(struct.unpack_from('<3f',raw,ni))
    axis=Vector((1,0,0) if abs(n.x)<.9 else (0,1,0))
    t=n.cross(axis).normalized()
    struct.pack_into('<4f',raw,ti,t.x,t.y,t.z,1 if w>=0 else -1)
    repaired+=1
print('Repaired degenerate UV tangents:',repaired,flush=True)
doc['asset']['extras']={'lunetteCaba':{
 'anchor':[0,0.135,0.19],
 'referenceWidth':0.8858,
 'estimatedDimensions':True,
 'sourceRelease':'https://github.com/printeefy1-commits/tryit/releases/tag/models-v2',
 'sourceSha256':source_hash,
 'processing':'75000 total triangle budget; separate owner-authored frame/lens materials and vertex colours preserved; photo-relative fitting anchor, no measured physical dimensions.'}}
encoded=json.dumps(doc,separators=(',',':')).encode()
encoded+=b' '*((-len(encoded))%4)
remaining=raw[20+size:]
output.write_bytes(struct.pack('<4sII',b'glTF',2,20+len(encoded)+len(remaining))+struct.pack('<II',len(encoded),kind)+encoded+remaining)
print('Fitted GLB bytes',output.stat().st_size,flush=True)
