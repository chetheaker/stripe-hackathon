import * as THREE from 'three'

import { pepperoniTexture, rng } from './textures'

/*
  Every topping is a small procedural mesh, drawn in pizza space where the
  pizza's radius is 1. One InstancedMesh per topping keeps it fast.
*/

const flat = (geometry) => geometry.rotateX(-Math.PI / 2)

const leaf = (length, width) => {
  const shape = new THREE.Shape()
  shape.moveTo(0, -length / 2)
  shape.bezierCurveTo(width, -length / 4, width * 0.7, length / 3, 0, length / 2)
  shape.bezierCurveTo(-width * 0.7, length / 3, -width, -length / 4, 0, -length / 2)
  return flat(new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false, curveSegments: 10 }))
}

const mushroomSlice = () => {
  const shape = new THREE.Shape()
  shape.moveTo(-0.022, -0.07)
  shape.lineTo(0.022, -0.07)
  shape.lineTo(0.026, -0.005)
  shape.bezierCurveTo(0.08, -0.01, 0.1, 0.03, 0.075, 0.058)
  shape.bezierCurveTo(0.05, 0.085, -0.05, 0.085, -0.075, 0.058)
  shape.bezierCurveTo(-0.1, 0.03, -0.08, -0.01, -0.026, -0.005)
  shape.lineTo(-0.022, -0.07)
  return flat(new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 12 }))
}

const pineappleChunk = () => {
  const shape = new THREE.Shape()
  shape.moveTo(-0.06, -0.03)
  shape.lineTo(0.06, -0.03)
  shape.lineTo(0.04, 0.035)
  shape.lineTo(-0.04, 0.035)
  shape.lineTo(-0.06, -0.03)
  return flat(new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 }))
}

const roughChunk = (radius, detail, seed, squash) => {
  const geometry = new THREE.IcosahedronGeometry(radius, detail)
  const random = rng(seed)
  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    const wobble = 0.8 + random() * 0.4
    position.setXYZ(i, position.getX(i) * wobble, position.getY(i) * wobble * squash, position.getZ(i) * wobble)
  }
  geometry.computeVertexNormals()
  return geometry
}

const arc = (radius, tube, sweep) => flat(new THREE.TorusGeometry(radius, tube, 8, 24, sweep))

const material = (color, options = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, ...options })

const SPEC_FACTORY = {
  pepperoni: () => ({
    geometry: new THREE.CylinderGeometry(0.1, 0.1, 0.022, 32),
    material: material('#b8321f', { roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.4, map: pepperoniTexture() }),
    baked: '#7d1d10',
    count: 14,
    spacing: 0.21,
    height: 0.012,
  }),
  mushrooms: () => ({ geometry: mushroomSlice(), material: material('#e2d3b6', { roughness: 0.75 }), baked: '#a78456', count: 11, spacing: 0.17, height: 0.004 }),
  green_peppers: () => ({ geometry: arc(0.07, 0.013, Math.PI * 1.15), material: material('#3d9a2f', { roughness: 0.3, clearcoat: 0.8 }), baked: '#2c6b1f', count: 12, spacing: 0.15, height: 0.012 }),
  red_onion: () => ({ geometry: arc(0.08, 0.008, Math.PI * 1.35), material: material('#a6467f', { roughness: 0.35, clearcoat: 0.6, transmission: 0.2, thickness: 0.02 }), baked: '#7a2e5a', count: 12, spacing: 0.14, height: 0.008 }),
  black_olives: () => ({ geometry: flat(new THREE.TorusGeometry(0.036, 0.017, 12, 24)), material: material('#1f1b1d', { roughness: 0.22, clearcoat: 1 }), baked: '#120f10', count: 14, spacing: 0.12, height: 0.016 }),
  sweetcorn: () => ({ geometry: roughChunk(0.02, 1, 3, 0.75), material: material('#f5c522', { roughness: 0.3, clearcoat: 0.6 }), baked: '#d99a13', count: 34, spacing: 0.07, height: 0.015 }),
  pineapple: () => ({ geometry: pineappleChunk(), material: material('#f7d64f', { roughness: 0.35, clearcoat: 0.7 }), baked: '#d7a531', count: 12, spacing: 0.15, height: 0.004 }),
  ham: () => ({ geometry: new THREE.BoxGeometry(0.12, 0.012, 0.1), material: material('#ec9f9c', { roughness: 0.6 }), baked: '#c97a72', count: 10, spacing: 0.17, height: 0.007 }),
  roast_chicken: () => ({ geometry: roughChunk(0.05, 1, 9, 0.5), material: material('#e4c191', { roughness: 0.7 }), baked: '#bd8a50', count: 13, spacing: 0.15, height: 0.02 }),
  spicy_beef: () => ({ geometry: roughChunk(0.03, 0, 13, 0.8), material: material('#6e3420', { roughness: 0.8 }), baked: '#4a1f12', count: 26, spacing: 0.09, height: 0.02 }),
  jalapenos: () => ({ geometry: flat(new THREE.TorusGeometry(0.045, 0.014, 10, 22)), material: material('#5f9e2c', { roughness: 0.3, clearcoat: 0.7 }), baked: '#41721c', count: 12, spacing: 0.13, height: 0.014 }),
  nduja: () => ({ geometry: roughChunk(0.055, 2, 21, 0.4), material: material('#c2341c', { roughness: 0.4, clearcoat: 0.5 }), baked: '#8e2310', count: 10, spacing: 0.18, height: 0.016 }),
  basil: () => ({ geometry: leaf(0.13, 0.06), material: material('#3e8f34', { roughness: 0.4, clearcoat: 0.5, side: THREE.DoubleSide }), baked: '#3e8f34', count: 8, spacing: 0.2, height: 0.03 }),
  rocket: () => ({ geometry: leaf(0.16, 0.035), material: material('#5a8c32', { roughness: 0.45, side: THREE.DoubleSide }), baked: '#5a8c32', count: 16, spacing: 0.11, height: 0.035 }),
}

const cache = {}

export const toppingSpec = (id) => {
  if (!cache[id]) {
    const spec = SPEC_FACTORY[id]()
    cache[id] = { ...spec, color: spec.material.color.clone(), bakedColor: new THREE.Color(spec.baked) }
  }
  return cache[id]
}

// Where each piece lands (pizza space) and the arc it flies in on.
export const placements = (id, spec) => {
  let seed = 0
  for (const char of id) seed = (seed * 31 + char.charCodeAt(0)) % 100000
  const random = rng(seed + 1)
  const points = []
  let attempts = 0
  while (points.length < spec.count && attempts < 4000) {
    attempts++
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * 0.68
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    if (points.some((point) => Math.hypot(point.x - x, point.z - z) < spec.spacing)) continue
    points.push({ x, z })
  }
  return points.map((point, index) => ({
    ...point,
    y: 0.068 + spec.height + index * 0.0006,
    yaw: random() * Math.PI * 2,
    tilt: (random() - 0.5) * 0.12,
    delay: index * 0.045 + random() * 0.08,
    start: new THREE.Vector3(point.x * 0.3 + (random() - 0.5) * 1.6, 2.4 + random() * 1.2, 2.2 + random() * 1.2),
    spin: new THREE.Vector3((random() - 0.5) * 9, (random() - 0.5) * 9, (random() - 0.5) * 9),
    scatter: new THREE.Vector3(point.x * 2 + (random() - 0.5), 2.5 + random(), point.z * 2 + (random() - 0.5)),
  }))
}
