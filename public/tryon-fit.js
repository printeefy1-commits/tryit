import * as THREE from 'three';

// MediaPipe z uses the same approximate scale as normalized x. Keep the face
// and glasses in one orthographic coordinate space so depth masking aligns.
export function landmarkPoint(point, aspect) {
  return new THREE.Vector3((point.x - 0.5) * 2 * aspect, (0.5 - point.y) * 2, -point.z * 2 * aspect);
}

export function estimateFit(face, aspect, scale = 1, offset = 0) {
  const point = index => landmarkPoint(face[index], aspect);
  const eyeCenter = (iris, a, b) => face[iris] ? point(iris) : point(a).add(point(b)).multiplyScalar(0.5);
  const left = eyeCenter(468, 33, 133);
  const right = eyeCenter(473, 362, 263);
  // Use 3D separation to compensate for projected eye spacing shrinking on turns.
  // 2.2 is an aesthetic initial fit, not a physical size measurement.
  const pupilDistance = left.distanceTo(right);
  if (!Number.isFinite(pupilDistance) || pupilDistance < 0.0001) return null;
  const horizontal = point(263).sub(point(33)).normalize();
  let vertical = point(10).sub(point(152));
  vertical.addScaledVector(horizontal, -vertical.dot(horizontal)).normalize();
  const normal = horizontal.clone().cross(vertical).normalize();
  if (normal.z < 0 || normal.lengthSq() < 0.5) return null;
  vertical = normal.clone().cross(horizontal).normalize();
  const rotation = new THREE.Matrix4().makeBasis(horizontal, vertical, normal);
  const position = left.clone().add(right).multiplyScalar(0.5);
  // Put the lens plane slightly in front of the nasal bridge, while the temples
  // extend backwards and are hidden by the tracked face depth mesh.
  position.z = point(168).z;
  position.addScaledVector(normal, pupilDistance * 0.06);
  position.addScaledVector(vertical, offset * pupilDistance);
  return {position, quaternion: new THREE.Quaternion().setFromRotationMatrix(rotation), width: pupilDistance * 2.2 * scale};
}

export function smoothLandmarks(previous, current, alpha) {
  if (!previous || previous.length !== current.length) return current.map(p => ({...p}));
  for (let i = 0; i < current.length; i++) {
    for (const axis of ['x', 'y', 'z']) previous[i][axis] += (current[i][axis] - previous[i][axis]) * alpha;
  }
  return previous;
}

export function createFaceOccluder(triangles) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3));
  geometry.setIndex(triangles);
  const material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: true, depthTest: true, side: THREE.DoubleSide});
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'tracked-face-depth-mask';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

export function updateFaceOccluder(mesh, face, aspect) {
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const p = landmarkPoint(face[i], aspect);
    positions.setXYZ(i, p.x, p.y, p.z);
  }
  positions.needsUpdate = true;
  mesh.visible = true;
}
