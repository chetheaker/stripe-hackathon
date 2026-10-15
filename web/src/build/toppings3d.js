import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import pepperoniAtlasUrl from './assets/pepperoni-atlas.png'
import {
  basilAtlas, beefSurface, chickenSurface, cornSurface, hamAtlas, jalapenoAtlas, mushroomAtlas, ndujaSurface,
  noise2, oliveAtlas, onionAtlas, pepperAtlas, pineappleAtlas, rng, rocketAtlas,
} from './textures'

/*
  Every topping lives in pizza space (the pizza's radius is 1). Slices are
  "cards": a top-down texture with alpha, stacked three layers deep so the cut
  edge has thickness, and cupped when baked. Chunky things (beef, chicken,
  corn, nduja) are noise-displaced meshes. One InstancedMesh per topping.
*/

export const SURFACE_Y = 0.044

/* ---------- Cards ---------- */

const cardGeometry = (thickness) => {
  const layers = [0, 0.5, 1].map((layer) => {
    const plane = new THREE.PlaneGeometry(1, 1, 8, 8).rotateX(-Math.PI / 2)
    plane.translate(0, layer * thickness, 0)
    plane.setAttribute('aLayer', new THREE.Float32BufferAttribute(new Array(plane.attributes.position.count).fill(layer), 1))
    return plane
  })
  return mergeGeometries(layers)
}

const CARD_VERTEX_HEAD = /* glsl */ `
attribute float aVariant;
attribute float aLayer;
uniform float uBake;
uniform float uCup;
uniform float uCurl;
uniform vec2 uGrid;
varying float vLayer;
`

const CARD_VERTEX_BODY = /* glsl */ `
  float rr = dot(position.xz, position.xz) * 4.0;
  transformed.y += uCup * (0.35 + uBake) * rr * 0.5 + uCurl * (position.x * position.x * 4.0);
`

const CARD_UV = /* glsl */ `
  vec2 cell = vec2(mod(aVariant, uGrid.x), floor(aVariant / uGrid.x));
  vMapUv = vec2((cell.x + uv.x) / uGrid.x, (uv.y + (uGrid.y - 1.0 - cell.y)) / uGrid.y);
  vLayer = aLayer;
`

const patchCard = (material, uniforms, { depth = false } = {}) => {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${CARD_VERTEX_HEAD}\nvoid main() {`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERTEX_BODY}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${CARD_UV}`)
    if (!depth) {
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uBake;\nuniform vec3 uBakeTint;\nvarying float vLayer;\nvoid main() {')
        .replace('#include <map_fragment>', `#include <map_fragment>
          diffuseColor.rgb *= mix(0.42, 1.0, vLayer);
          diffuseColor.rgb *= mix(vec3(1.0), uBakeTint, uBake);`)
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'varying float vLayer;\nvoid main() {')
    }
  }
  return material
}

const card = ({ atlas, grid = [4, 1], size, thickness = 0.01, cup = 0, curl = 0, bakeTint = '#d9c4a8', material = {}, ...rest }) => () => {
  const uniforms = {
    uBake: { value: 0 },
    uCup: { value: cup },
    uCurl: { value: curl },
    uGrid: { value: new THREE.Vector2(...grid) },
    uBakeTint: { value: new THREE.Color(bakeTint) },
  }
  const map = atlas()
  const mat = patchCard(new THREE.MeshPhysicalMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, ...material }), uniforms)
  const depth = patchCard(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5 }), uniforms, { depth: true })
  return { geometry: cardGeometry(thickness / size), material: mat, depth, uniforms, size, variants: grid[0] * grid[1], kind: 'card', ...rest }
}

const loadAtlas = (url) => () => {
  const texture = new THREE.TextureLoader().load(url)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/* ---------- Chunks ---------- */

const lumpy = (radius, detail, squash, roughness, seed) => {
  let geometry = new THREE.IcosahedronGeometry(radius, detail)
  geometry.deleteAttribute('normal')
  geometry = mergeVertices(geometry)
  const position = geometry.attributes.position
  const vertex = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i)
    const n = noise2(vertex.x * 40 + seed, vertex.z * 40 + vertex.y * 30 + seed)
    vertex.multiplyScalar(1 + (n - 0.5) * roughness)
    vertex.y *= squash
    position.setXYZ(i, vertex.x, vertex.y, vertex.z)
  }
  geometry.computeVertexNormals()
  // Spherical UVs so surface textures wrap the lump.
  const uv = new Float32Array(position.count * 2)
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).normalize()
    uv[i * 2] = 0.5 + Math.atan2(vertex.z, vertex.x) / (Math.PI * 2)
    uv[i * 2 + 1] = 0.5 + Math.asin(Math.max(-1, Math.min(1, vertex.y))) / Math.PI
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geometry
}

const chunk = ({ geometry, surface, material = {}, baked, ...rest }) => () => {
  const mat = new THREE.MeshPhysicalMaterial({ map: surface(), roughness: 0.6, ...material })
  return { geometry: geometry(), material: mat, kind: 'chunk', color: mat.color.clone(), bakedColor: new THREE.Color(baked), ...rest }
}

/* ---------- The toppings ---------- */

const SPECS = {
  pepperoni: card({ atlas: loadAtlas(pepperoniAtlasUrl), grid: [4, 2], size: 0.23, thickness: 0.012, cup: 0.05, bakeTint: '#c99a8f', material: { roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.35 }, count: 16, spacing: 0.2 }),
  mushrooms: card({ atlas: mushroomAtlas, size: 0.22, thickness: 0.012, bakeTint: '#c7ab88', material: { roughness: 0.7, sheen: 0.4 }, count: 12, spacing: 0.17 }),
  black_olives: card({ atlas: oliveAtlas, size: 0.1, thickness: 0.016, bakeTint: '#b0a2a8', material: { roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.15 }, count: 16, spacing: 0.1 }),
  jalapenos: card({ atlas: jalapenoAtlas, size: 0.13, thickness: 0.01, bakeTint: '#c4c1a0', material: { roughness: 0.32, clearcoat: 0.8 }, count: 14, spacing: 0.12 }),
  green_peppers: card({ atlas: pepperAtlas, size: 0.22, thickness: 0.014, bakeTint: '#b9b49a', material: { roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.2 }, count: 12, spacing: 0.14 }),
  red_onion: card({ atlas: onionAtlas, size: 0.22, thickness: 0.008, bakeTint: '#d7c3c0', material: { roughness: 0.3, clearcoat: 0.7, transmission: 0.15, thickness: 0.01 }, count: 12, spacing: 0.13 }),
  ham: card({ atlas: hamAtlas, size: 0.19, thickness: 0.008, cup: 0.02, bakeTint: '#d6aaa0', material: { roughness: 0.55, sheen: 0.3 }, count: 10, spacing: 0.17 }),
  pineapple: card({ atlas: pineappleAtlas, size: 0.15, thickness: 0.022, bakeTint: '#dcb98a', material: { roughness: 0.3, clearcoat: 0.6, transmission: 0.1, thickness: 0.02 }, count: 12, spacing: 0.13 }),
  basil: card({ atlas: basilAtlas, size: 0.2, thickness: 0.004, curl: 0.04, bakeTint: '#a3a18a', material: { roughness: 0.35, clearcoat: 0.6, sheen: 0.4 }, count: 7, spacing: 0.2, high: 0.012 }),
  rocket: card({ atlas: rocketAtlas, size: 0.24, thickness: 0.004, curl: 0.05, bakeTint: '#ffffff', material: { roughness: 0.4, clearcoat: 0.4 }, count: 14, spacing: 0.12, high: 0.016 }),
  spicy_beef: chunk({ geometry: () => lumpy(0.022, 1, 0.75, 0.7, 3), surface: beefSurface, baked: '#3b1d12', material: { roughness: 0.78 }, count: 32, spacing: 0.08 }),
  roast_chicken: chunk({ geometry: () => lumpy(0.042, 2, 0.55, 0.45, 9), surface: chickenSurface, baked: '#c99f6a', material: { roughness: 0.7, sheen: 0.3 }, count: 14, spacing: 0.15 }),
  sweetcorn: chunk({ geometry: () => lumpy(0.016, 1, 0.8, 0.25, 15).scale(1, 0.9, 1.25), surface: cornSurface, baked: '#e6aa2a', material: { roughness: 0.25, clearcoat: 0.8 }, count: 42, spacing: 0.065 }),
  nduja: chunk({ geometry: () => lumpy(0.048, 2, 0.42, 0.55, 21), surface: ndujaSurface, baked: '#7e1f0e', material: { roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }, count: 10, spacing: 0.18 }),
}

const cache = {}

export const toppingSpec = (id) => {
  cache[id] ??= SPECS[id]()
  return cache[id]
}

// Builds every topping's materials ahead of time so the first one doesn't stutter.
export const warmToppings = () => Object.keys(SPECS).forEach(toppingSpec)

// Where each piece lands (pizza space) and the arc it drops in on.
export const placements = (id, spec, radius = 0.7) => {
  let seed = 0
  for (const char of id) seed = (seed * 31 + char.charCodeAt(0)) % 100000
  const random = rng(seed + 1)
  const points = []
  let attempts = 0
  while (points.length < spec.count && attempts < 5000) {
    attempts++
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * radius
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    if (points.some((point) => Math.hypot(point.x - x, point.z - z) < spec.spacing)) continue
    points.push({ x, z })
  }
  return points.map((point, index) => {
    const tone = 0.88 + random() * 0.2
    return {
      ...point,
      y: SURFACE_Y + (spec.high ?? 0) + index * 0.0007,
      yaw: random() * Math.PI * 2,
      tiltX: (random() - 0.5) * (spec.kind === 'chunk' ? 3 : 0.08),
      tiltZ: (random() - 0.5) * (spec.kind === 'chunk' ? 3 : 0.08),
      scale: 0.86 + random() * 0.28,
      variant: Math.floor(random() * (spec.variants ?? 1)),
      tint: new THREE.Color(tone, tone * (0.97 + random() * 0.05), tone * (0.95 + random() * 0.08)),
      delay: index * 0.04 + random() * 0.08,
      start: new THREE.Vector3(point.x * 0.4 + (random() - 0.5) * 0.8, 1.5 + random() * 0.9, point.z * 0.4 + 0.9 + random() * 0.6),
      spin: new THREE.Vector3((random() - 0.5) * 8, (random() - 0.5) * 10, (random() - 0.5) * 8),
      scatter: new THREE.Vector3(point.x * 2.4 + (random() - 0.5), 1.8 + random(), point.z * 2.4 + (random() - 0.5)),
    }
  })
}
