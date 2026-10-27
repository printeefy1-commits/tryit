"""Run: blender --background --threads 2 --python scripts/build-head-12028.py
Manual photo-referenced approximation, NOT measured manufacturer CAD.
Geometry uses X=width, Y=up, Z=towards camera; dimensions in metres.
"""
import bpy
import json
import math
from mathutils import Vector
from mathutils.geometry import interpolate_bezier
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/products/head-12028/head-12028-col400.glb'
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, metallic, roughness, alpha=1):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = (*color, 1)
    node.inputs['Metallic'].default_value = metallic
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Specular IOR Level'].default_value = .18
    node.inputs['Alpha'].default_value = alpha
    mat.diffuse_color = (*color, alpha)
    if alpha < 1:
        mat.surface_render_method = 'DITHERED'
    mat.use_backface_culling = False
    return mat

navy = material('Col400 | deep navy acetate (estimated)', (.007, .014, .032), .02, .4)
lens = material('Blue-grey lens | visual approximation of reflections', (.025, .060, .105), .08, .32, .94)
silver = material('Hinge | satin metal', (.32, .36, .40), .72, .3)
white = material('HEAD temple lettering', (.72, .75, .78), .15, .38)

# Approximate contours traced from the supplied front view IMG_2529.
# Millimetre dimensions below are provisional, not measurements.
outer = [(-70,19),(-50,20),(-30,18),(-13,14),(0,10),(13,14),(30,18),(50,20),(70,19),
         (69,6),(65,3),(62,-17),(53,-26),(35,-28),(17,-25),(11,-17),(6,2),(0,4),
         (-6,2),(-11,-17),(-17,-25),(-35,-28),(-53,-26),(-62,-17),(-65,3),(-69,6)]
left = [(-59,13),(-44,14),(-27,12),(-14,6),(-12,-1),(-17,-15),(-25,-22),(-41,-23),(-53,-20),(-59,-12),(-61,1)]
right = [(-x,y) for x,y in reversed(left)]


def area(points):
    return sum(x*v-u*y for (x,y),(u,v) in zip(points, points[1:]+points[:1]))


def spline(curve, points, ccw=True):
    if (area(points)>0) != ccw:
        points = list(reversed(points))
    s=curve.splines.new('BEZIER')
    s.bezier_points.add(len(points)-1)
    for p,(x,y) in zip(s.bezier_points,points):
        p.co=(x/1000,y/1000,0)
        p.handle_left_type='AUTO'
        p.handle_right_type='AUTO'
    s.use_cyclic_u=True
    return s

front = bpy.data.curves.new('One-piece frame with two open lens apertures','CURVE')
front.dimensions='2D'
front.resolution_u=10
front.fill_mode='BOTH'
front.extrude=.0023
front.bevel_depth=.0006
front.bevel_resolution=3
spline(front,outer)
spline(front,left,False)
spline(front,right,False)
obj=bpy.data.objects.new('Navy frame and bridge',front)
bpy.context.collection.objects.link(obj)
obj.data.materials.append(navy)
bpy.context.view_layer.objects.active=obj
obj.select_set(True)
bpy.ops.object.convert(target='MESH')
obj.select_set(False)
for polygon in obj.data.polygons:
    polygon.use_smooth=abs(polygon.normal.z)<.95


def make_lens(points, name):
    c=bpy.data.curves.new('Temporary outline','CURVE')
    c.dimensions='2D'
    outline=spline(c,points)
    # Force an update so automatic Bezier handles are evaluated.
    temp=bpy.data.objects.new('Temporary outline',c)
    bpy.context.collection.objects.link(temp)
    bpy.context.view_layer.update()
    samples=[]
    bp=outline.bezier_points
    for i,p in enumerate(bp):
        q=bp[(i+1)%len(bp)]
        samples.extend(interpolate_bezier(p.co,p.handle_right,q.handle_left,q.co,10)[:-1])
    center=sum(samples,Vector())/len(samples)
    n=len(samples)
    verts=[(center.x,center.y,.0045)]
    for ring in range(1,6):
        ratio=ring/5
        for p in samples:
            v=center+(p-center)*ratio
            verts.append((v.x,v.y,.0018+.0027*(1-ratio*ratio)))
    faces=[]
    for i in range(n):
        faces.append((0,1+i,1+(i+1)%n))
    for ring in range(4):
        a=1+ring*n
        b=a+n
        for i in range(n):
            j=(i+1)%n
            faces.append((a+i,b+i,b+j,a+j))
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    glass=bpy.data.objects.new(name,mesh)
    bpy.context.collection.objects.link(glass)
    glass.data.materials.append(lens)
    for p in mesh.polygons:p.use_smooth=True
    bpy.data.objects.remove(temp,do_unlink=True)
    bpy.data.curves.remove(c)

make_lens(left,'Left curved lens')
make_lens(right,'Right curved lens')


def temple(side):
    # Explicit cross sections keep the temple broad vertically and thin across X.
    points=[(.067,.012,-.002,1),(.072,.012,-.022,1),(.073,.011,-.066,.86),(.071,.010,-.101,.72),(.065,-.001,-.125,.66),(.061,-.011,-.135,.55)]
    curve=bpy.data.curves.new('Temporary temple path','CURVE')
    curve.dimensions='3D'
    line=curve.splines.new('BEZIER')
    line.bezier_points.add(len(points)-1)
    for p,(x,y,z,r) in zip(line.bezier_points,points):
        p.co=(side*x,y,z)
        p.handle_left_type='AUTO'
        p.handle_right_type='AUTO'
    temp=bpy.data.objects.new('Temporary temple path',curve)
    bpy.context.collection.objects.link(temp)
    bpy.context.view_layer.update()
    samples=[]
    for i,p in enumerate(line.bezier_points[:-1]):
        q=line.bezier_points[i+1]
        for j,co in enumerate(interpolate_bezier(p.co,p.handle_right,q.handle_left,q.co,10)[:-1]):
            r=points[i][3]+(points[i+1][3]-points[i][3])*j/9
            samples.append((co,r))
    samples.append((line.bezier_points[-1].co.copy(),points[-1][3]))
    verts=[]
    for center,r in samples:
        for x,y in [(-.0015,-.006),(.0015,-.006),(.0015,.006),(-.0015,.006)]:
            verts.append(tuple(center+Vector((x*r,y*r,0))))
    faces=[(3,2,1,0)]
    for i in range(len(samples)-1):
        for j in range(4):
            k=(j+1)%4
            faces.append((i*4+j,i*4+k,(i+1)*4+k,(i+1)*4+j))
    last=(len(samples)-1)*4
    faces.append(tuple(last+j for j in range(4)))
    mesh=bpy.data.meshes.new('Broad acetate temple')
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    ob=bpy.data.objects.new(('Right' if side>0 else 'Left')+' open temple',mesh)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(navy)
    bpy.context.view_layer.objects.active=ob
    bevel=ob.modifiers.new('Rounded arm edges','BEVEL')
    bevel.width=.0005
    bevel.segments=3
    for p in mesh.polygons:p.use_smooth=True
    bpy.data.objects.remove(temp,do_unlink=True)
    bpy.data.curves.remove(curve)
    bpy.ops.mesh.primitive_cube_add(size=1,location=(side*.0678,.010,-.001))
    hinge=bpy.context.object
    hinge.name='Metal hinge insert'
    hinge.dimensions=(.004,.008,.005)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bevel=hinge.modifiers.new('Soft hinge edges','BEVEL')
    bevel.width=.0007
    bevel.segments=3
    hinge.data.materials.append(silver)
    font=bpy.data.curves.new('HEAD brand text','FONT')
    font.body='HEAD'
    font.size=.005
    font.align_x='CENTER'
    font.align_y='CENTER'
    font.extrude=.000015
    text=bpy.data.objects.new('HEAD temple mark',font)
    text.location=(side*.0753,.011,-.031)
    text.rotation_euler=(0,side*math.pi/2,0)
    bpy.context.collection.objects.link(text)
    font.materials.append(white)

for side in [-1,1]:temple(side)
# Text/curves are converted before export. No cameras, image textures, or external resources.
bpy.ops.object.select_all(action='SELECT')
for ob in list(bpy.context.selected_objects):
    bpy.context.view_layer.objects.active=ob
    if ob.type in {'CURVE','FONT'}:
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.ops.object.convert(target='MESH')
bpy.ops.object.select_all(action='SELECT')
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(OUTPUT),export_format='GLB',use_selection=True,export_yup=False,export_extras=True,export_apply=True,export_texcoords=False)
# Add an explicit front-plane fitting anchor, independent of temple length.
raw=OUTPUT.read_bytes()
json_size,json_type=struct.unpack_from('<II',raw,12)
doc=json.loads(raw[20:20+json_size])
doc['asset']['extras']={'lunetteCaba':{
    'anchor':[0,-.004,0], 'referenceWidth':.14, 'estimatedDimensions':True,
    'reference':'HEAD Mod.12028 Col.400; owner-supplied IMG_2529,2530,2533,2536,2552',
    'notes':'Manual photo approximation. Nominal dimensions, lens reflectance and hidden surfaces are unmeasured.'}}
encoded=json.dumps(doc,separators=(',',':')).encode()
encoded+=b' '*((-len(encoded))%4)
remaining=raw[20+json_size:]
OUTPUT.write_bytes(struct.pack('<4sII',b'glTF',2,20+len(encoded)+len(remaining))+struct.pack('<II',len(encoded),json_type)+encoded+remaining)
print('Exported photo-referenced approximation:',OUTPUT,OUTPUT.stat().st_size,'bytes')
