import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer, PresentationControls, Sparkles } from '@react-three/drei'
import { EffectComposer, N8AO, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'

import crustStripUrl from './assets/crust-strip.jpg'
import { SIZES_BY_ID, currentStep } from './buildModel'
import { BUMP, NOISE } from './glsl'
import { sound } from './sound'
import { noise2, paperTexture, rng, risoMatTexture, shadowBlobTexture, softDotTexture } from './textures'
import { placements, toppingSpec, warmToppings } from './toppings3d'

/*
  The pizza, in pizza space: radius 1, scaled to the chosen size. Realism
  comes from a photographed crust (unwrapped from our menu photo) and real
  pepperoni slices, procedural sauce and cheese shaded per pixel, soft
  shadows and ambient occlusion. It sits on Rocco's riso paper.
*/

const DEBUG = new Set(new URLSearchParams(location.search).getAll('debug'))
const BASE_Y = 0.03
const BAKE_SECONDS = 3.4
const clamp01 = (value) => Math.min(1, Math.max(0, value))
const easeOutCubic = (t) => 1 - (1 - t) ** 3
const easeInCubic = (t) => t * t * t
const smooth = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

class Spring {
  constructor(value, stiffness = 170, damping = 14) {
    this.value = value
    this.velocity = 0
    this.stiffness = stiffness
    this.damping = damping
  }
  step(target, dt) {
    const force = -this.stiffness * (this.value - target) - this.damping * this.velocity
    this.velocity += force * dt
    this.value += this.velocity * dt
    return this.value
  }
}

const CRUSTS = {
  classic: { foot: 0.845, height: 0.072 },
  stuffed: { foot: 0.79, height: 0.108 },
  gluten_free: { foot: 0.87, height: 0.048 },
}

// Linear-space colours for each sauce: deep, bright, and thin over dough.
const SAUCES = {
  tomato: [[0.3, 0.025, 0.012], [0.52, 0.07, 0.022], [0.62, 0.3, 0.13]],
  bbq: [[0.09, 0.022, 0.008], [0.2, 0.06, 0.02], [0.42, 0.2, 0.09]],
  garlic: [[0.78, 0.7, 0.52], [0.92, 0.86, 0.7], [0.82, 0.68, 0.46]],
}
const CHEESES = { mozzarella: [0.93, 0.89, 0.77], vegan: [0.94, 0.88, 0.66] }

/* ---------- Dough ---------- */

const angleGap = (a, b) => {
  const d = Math.abs(a - b) % (Math.PI * 2)
  return d > Math.PI ? Math.PI * 2 - d : d
}

// A hand-stretched base: not quite round, a lumpy rim with a few big bubbles.
const doughGeometry = (crust) => {
  const { foot, height } = CRUSTS[crust]
  const profile = []
  for (let i = 0; i <= 10; i++) {
    const r = (foot * i) / 10
    profile.push({ r, y: BASE_Y, v: 0.3 * (r / foot), rim: 0 })
  }
  for (let i = 1; i <= 30; i++) {
    const t = i / 30
    const dome = Math.sin(Math.PI * t) ** 0.55
    profile.push({ r: foot + (1 - foot) * t, y: BASE_Y + height * dome * (1 - 0.18 * t), v: 0.3 + 0.62 * t, rim: Math.sin(Math.PI * t) })
  }
  for (let k = 1; k <= 5; k++) {
    const a = (k / 5) * (Math.PI / 2)
    profile.push({ r: 0.982 + 0.018 * Math.cos(a), y: BASE_Y * (1 - Math.sin(a)), v: 0.92, rim: 0 })
  }
  profile.push({ r: 0.5, y: 0, v: 0.92, rim: 0 }, { r: 0.0001, y: 0, v: 0.92, rim: 0 })

  const random = rng(crust.length * 13 + 5)
  const bubbles = Array.from({ length: 11 }, () => ({ at: random() * Math.PI * 2, width: 0.04 + random() * 0.12, amp: 0.12 + random() * 0.38 }))
  const segments = 360
  const P = profile.length
  const positions = new Float32Array((segments + 1) * P * 3)
  const uvs = new Float32Array((segments + 1) * P * 2)
  const rims = new Float32Array((segments + 1) * P)

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const wobble = 1 + 0.022 * (noise2(cos * 1.4 + 10, sin * 1.4 + 10) - 0.5) + 0.006 * Math.sin(theta * 3 + 1)
    let bump = 1 + 0.5 * (noise2(cos * 5 + 3, sin * 5 + 7) - 0.5)
    for (const bubble of bubbles) bump += bubble.amp * Math.exp(-((angleGap(theta, bubble.at) / bubble.width) ** 2))
    profile.forEach((point, j) => {
      const lumps = 0.007 * (noise2(cos * 28 + point.r * 11, sin * 28 + point.r * 11) - 0.5) * point.rim
      const r = point.r * wobble + point.rim * 0.016 * (bump - 1)
      const y = point.rim > 0 ? BASE_Y + (point.y - BASE_Y) * bump + lumps : point.y
      const index = i * P + j
      positions.set([r * cos, y, r * sin], index * 3)
      uvs.set([i / segments, point.v], index * 2)
      rims[index] = point.rim
    })
  }

  const indices = []
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j
      const b = (i + 1) * P + j
      const c = (i + 1) * P + j + 1
      const d = i * P + j + 1
      indices.push(a, b, d, b, c, d)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setAttribute('aRim', new THREE.BufferAttribute(rims, 1))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  // Weld the seam's normals so there's no line at angle 0.
  const normals = geometry.attributes.normal
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  for (let j = 0; j < P; j++) {
    const last = segments * P + j
    a.fromBufferAttribute(normals, j).add(b.fromBufferAttribute(normals, last)).normalize()
    normals.setXYZ(j, a.x, a.y, a.z)
    normals.setXYZ(last, a.x, a.y, a.z)
  }
  return geometry
}

let crustMap = null
const loadCrust = () => {
  if (crustMap) return crustMap
  crustMap = new THREE.TextureLoader().load(crustStripUrl)
  crustMap.colorSpace = THREE.SRGBColorSpace
  crustMap.anisotropy = 8
  crustMap.wrapS = THREE.RepeatWrapping
  return crustMap
}

const doughMaterial = (uniforms) => {
  const map = loadCrust()
  const material = new THREE.MeshPhysicalMaterial({ map, bumpMap: map, bumpScale: 0.6, roughness: 0.82, sheen: 0.35, sheenColor: new THREE.Color('#fff1d6') })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float aRim;\nuniform float uBake;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += aRim * smoothstep(0.0, 0.6, uBake) * 0.014;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uBake;\n${NOISE}\nvoid main() {`)
      .replace('#include <map_fragment>', `
        vec4 photo = texture2D( map, vMapUv );
        float grainNoise = fbm3( vMapUv * vec2( 120.0, 10.0 ) );
        vec3 raw = vec3( 0.86, 0.66, 0.39 ) * ( 0.95 + 0.08 * grainNoise );
        float flour = smoothstep( 0.6, 0.95, snoise( vMapUv * vec2( 900.0, 80.0 ) ) );
        raw = mix( raw, vec3( 0.96, 0.94, 0.9 ), flour * 0.45 );
        float toast = smoothstep( 0.0, 1.0, uBake );
        vec3 halfway = mix( raw, photo.rgb, 0.35 ) * vec3( 1.02, 0.95, 0.85 );
        vec3 dough = toast < 0.5 ? mix( raw, halfway, toast * 2.0 ) : mix( halfway, photo.rgb, toast * 2.0 - 1.0 );
        diffuseColor.rgb *= dough;
      `)
  }
  return material
}

/* ---------- Sauce ---------- */

const SAUCE_FRAGMENT = /* glsl */ `
  vec2 p = vLocal;
  float r = length( p );
  vec2 dir = p / max( r, 1e-4 );
  float turn = atan( p.y, p.x ) / 6.28318 + 0.5;
  float edge = 0.955 + 0.03 * snoise( dir * 2.5 + 3.0 ) + 0.016 * snoise( dir * 8.0 );
  if ( r > edge ) discard;
  float spiral = r * 0.8 + fract( turn - r * 2.2 ) * 0.2;
  if ( spiral > uReveal * 1.02 ) discard;

  float n = fbm( p * 4.0 );
  vec2 cells = worley( p * 22.0 );
  float chunk = smoothstep( 0.34, 0.1, cells.x ) * step( 0.55, cells.y );
  float thin = smoothstep( edge - 0.14, edge, r );
  vec3 col = mix( uDeep, uBright, smoothstep( -0.45, 0.55, n ) );
  col = mix( col, uBright * 1.25, chunk * 0.55 );
  col = mix( col, uThin, thin * 0.6 );
  float herb = smoothstep( 0.74, 0.92, snoise( p * 120.0 ) ) * smoothstep( 0.1, 0.6, snoise( p * 8.0 + 4.0 ) );
  col = mix( col, vec3( 0.05, 0.06, 0.012 ), herb * 0.8 );
  col *= mix( 1.0, 0.78, uBake );
  diffuseColor.rgb = col;
  sauceHeight = ( fbm3( p * 3.0 ) * 0.004 + chunk * 0.004 - thin * 0.003 ) * uHeightScale;
  sauceRough = 0.2 + thin * 0.2 + uBake * 0.25 - chunk * 0.05;
`

const sauceMaterial = (uniforms) => {
  const material = new THREE.MeshPhysicalMaterial({ roughness: 0.25, clearcoat: 0.55, clearcoatRoughness: 0.3 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vLocal;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xy;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `varying vec2 vLocal;\nuniform float uReveal;\nuniform float uBake;\nuniform float uHeightScale;\nuniform vec3 uDeep;\nuniform vec3 uBright;\nuniform vec3 uThin;\n${NOISE}\n${BUMP}\nvoid main() {\nfloat sauceHeight = 0.0;\nfloat sauceRough = 0.3;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SAUCE_FRAGMENT}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = sauceRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = perturbNormal( -vViewPosition, normal, sauceHeight );')
  }
  return material
}

/* ---------- Cheese ---------- */

const CHEESE_FRAGMENT = /* glsl */ `
  vec2 p = vLocal;
  float r = length( p );
  float n = fbm( p * 3.2 + 7.0 ) * 0.5 + 0.5;
  vec2 w = worley( p * 7.0 );
  float blob = n * 0.75 + ( 1.0 - w.x ) * 0.35;
  blob -= smoothstep( 0.8, 1.0, r ) * 0.7;
  float th = 1.08 - uCover * 0.98;
  if ( blob < th ) discard;
  float body = smoothstep( th, th + 0.14, blob );
  vec3 col = mix( uCheese, uCheese * vec3( 1.03, 0.94, 0.72 ), uBake );
  float grease = smoothstep( 0.2, 0.6, fbm3( p * 2.6 + 11.0 ) ) * uBake;
  col = mix( col, vec3( 0.93, 0.56, 0.2 ), grease * 0.4 );
  vec2 b = worley( p * 15.0 + 3.0 );
  float browned = smoothstep( 0.3, 0.9, uBake );
  float blister = smoothstep( 0.4, 0.06, b.x ) * step( 0.6, b.y ) * browned;
  col = mix( col, vec3( 0.64, 0.38, 0.13 ), blister * 0.78 );
  float charSpot = smoothstep( 0.17, 0.02, b.x ) * step( 0.84, b.y ) * smoothstep( 0.65, 1.0, uBake );
  col = mix( col, vec3( 0.22, 0.1, 0.035 ), charSpot * 0.8 );
  col *= mix( 0.8, 1.0, body );
  diffuseColor.rgb = col;
  cheeseHeight = ( body * 0.006 + blister * 0.004 + snoise( p * 45.0 ) * 0.0008 ) * uHeightScale;
  cheeseRough = mix( 0.55, 0.38, uBake ) - grease * 0.15;
`

const cheeseMaterial = (uniforms) => {
  const material = new THREE.MeshPhysicalMaterial({ roughness: 0.5, sheen: 0.5, sheenColor: new THREE.Color('#fffaf0'), clearcoat: 0.25, clearcoatRoughness: 0.4 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vLocal;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xy;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `varying vec2 vLocal;\nuniform float uCover;\nuniform float uBake;\nuniform float uHeightScale;\nuniform vec3 uCheese;\n${NOISE}\n${BUMP}\nvoid main() {\nfloat cheeseHeight = 0.0;\nfloat cheeseRough = 0.5;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CHEESE_FRAGMENT}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cheeseRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = perturbNormal( -vViewPosition, normal, cheeseHeight );')
  }
  return material
}

// A bent, flattened strip of grated mozzarella.
const shredGeometry = () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1, 8, 1, 2)
  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    position.setY(i, position.getY(i) - 0.9 * x * x + 0.05 * Math.sin(x * 9))
    position.setZ(i, position.getZ(i) * (1 - 0.35 * Math.abs(x * 2) ** 3))
  }
  geometry.computeVertexNormals()
  return geometry
}

/* ---------- Scene pieces ---------- */

function Table() {
  const paper = useMemo(() => {
    const texture = paperTexture()
    texture.repeat.set(10, 10)
    return texture
  }, [])
  const mat = useMemo(risoMatTexture, [])
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.001}>
        <planeGeometry args={[40, 40]} />
        <meshBasicMaterial map={paper} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.0005}>
        <circleGeometry args={[1.95, 128]} />
        <meshBasicMaterial map={mat} transparent depthWrite={false} opacity={0.75} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.001} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <shadowMaterial transparent opacity={0.2} color="#2a1e2c" />
      </mesh>
    </group>
  )
}

function DoughBall({ visible }) {
  const ref = useRef()
  const spring = useRef(new Spring(1, 140, 12))
  const material = useMemo(() => {
    const m = doughMaterial({ uBake: { value: 0 } })
    m.bumpScale = 0.2
    return m
  }, [])
  useFrame((state, dt) => {
    const s = spring.current.step(visible ? 1 : 0, Math.min(dt, 1 / 30))
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 1.8) * 0.012
    ref.current.visible = s > 0.02
    ref.current.scale.set(0.5 * (2 - s) * breathe, (0.34 * s) / breathe, 0.5 * (2 - s) * breathe)
    ref.current.position.y = 0.3 * s
  })
  return (
    <mesh ref={ref} castShadow receiveShadow material={material}>
      <sphereGeometry args={[1, 64, 40]} />
    </mesh>
  )
}

// A burst of flour when the base slaps down or the crust changes.
function FlourPuff({ trigger }) {
  const ref = useRef()
  const start = useRef(-10)
  const seen = useRef(trigger)
  const count = 90
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const particles = useMemo(() => {
    const random = rng(99)
    return Array.from({ length: count }, () => ({ angle: random() * Math.PI * 2, speed: 0.5 + random() * 1.4, lift: 0.2 + random() * 0.8, size: 0.006 + random() * 0.014 }))
  }, [])
  useFrame(({ clock }) => {
    if (seen.current !== trigger) {
      seen.current = trigger
      start.current = clock.elapsedTime
    }
    const life = clamp01((clock.elapsedTime - start.current) / 1.1)
    particles.forEach((particle, index) => {
      const travel = easeOutCubic(life) * particle.speed * 0.55
      dummy.position.set(Math.cos(particle.angle) * (1.02 + travel), 0.02 + Math.sin(life * Math.PI) * particle.lift * 0.25, Math.sin(particle.angle) * (1.02 + travel))
      dummy.scale.setScalar(life >= 1 ? 0 : particle.size * (1 - life ** 2) * 5)
      dummy.updateMatrix()
      ref.current.setMatrixAt(index, dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[null, null, count]} frustumCulled={false}>
      <sphereGeometry args={[1, 8, 6]} />
      <meshStandardMaterial color="#fffdf6" roughness={1} transparent opacity={0.8} />
    </instancedMesh>
  )
}

const lerpColor = (uniform, rgb, k) => {
  uniform.value.r += (rgb[0] - uniform.value.r) * k
  uniform.value.g += (rgb[1] - uniform.value.g) * k
  uniform.value.b += (rgb[2] - uniform.value.b) * k
}

function Sauce({ sauce, foot, bake }) {
  const uniforms = useMemo(() => ({
    uReveal: { value: 0 },
    uBake: { value: 0 },
    uHeightScale: { value: 1 },
    uDeep: { value: new THREE.Color(...SAUCES.tomato[0]) },
    uBright: { value: new THREE.Color(...SAUCES.tomato[1]) },
    uThin: { value: new THREE.Color(...SAUCES.tomato[2]) },
  }), [])
  const material = useMemo(() => sauceMaterial(uniforms), [uniforms])
  const ref = useRef()
  useFrame((_, dt) => {
    uniforms.uReveal.value = sauce ? Math.min(1, uniforms.uReveal.value + dt / 1.5) : Math.max(0, uniforms.uReveal.value - dt * 2)
    ref.current.visible = uniforms.uReveal.value > 0.001
    if (sauce) {
      const k = 1 - Math.exp(-dt * 5)
      lerpColor(uniforms.uDeep, SAUCES[sauce][0], k)
      lerpColor(uniforms.uBright, SAUCES[sauce][1], k)
      lerpColor(uniforms.uThin, SAUCES[sauce][2], k)
    }
    uniforms.uBake.value = bake.current
  })
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={BASE_Y + 0.0015} scale={foot - 0.004} material={material} receiveShadow>
      <circleGeometry args={[1, 180]} />
    </mesh>
  )
}

function Cheese({ cheese, foot, bake }) {
  const on = Boolean(cheese) && cheese !== 'none'
  const uniforms = useMemo(() => ({ uCover: { value: 0 }, uBake: { value: 0 }, uHeightScale: { value: 1 }, uCheese: { value: new THREE.Color(...CHEESES.mozzarella) } }), [])
  const material = useMemo(() => cheeseMaterial(uniforms), [uniforms])
  const geometry = useMemo(shredGeometry, [])
  const layer = useRef()
  const shreds = useRef()
  const startedAt = useRef(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const pieces = useMemo(() => {
    const random = rng(321)
    return Array.from({ length: 950 }, () => {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * 0.76
      return {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        y: BASE_Y + 0.006 + random() * 0.009,
        startY: 1.0 + random() * 1.4,
        driftX: (random() - 0.5) * 0.5,
        driftZ: (random() - 0.5) * 0.5 + 0.2,
        delay: random() * 1.0,
        yaw: random() * Math.PI * 2,
        tilt: (random() - 0.5) * 0.5,
        spin: (random() - 0.5) * 14,
        length: 0.03 + random() * 0.03,
        width: 0.011 + random() * 0.008,
        meltAt: random(),
      }
    })
  }, [])

  useEffect(() => {
    const tint = new THREE.Color()
    const random = rng(4)
    pieces.forEach((_, index) => {
      const tone = 0.86 + random() * 0.16
      shreds.current.setColorAt(index, tint.setRGB(tone, tone * (0.97 + random() * 0.03), tone * (0.88 + random() * 0.1)))
    })
    shreds.current.instanceColor.needsUpdate = true
  }, [pieces])

  useFrame(({ clock }, dt) => {
    const now = clock.elapsedTime
    if (on && startedAt.current == null) startedAt.current = now
    if (!on) startedAt.current = null
    const t = startedAt.current == null ? -1 : now - startedAt.current
    const b = bake.current

    // Before the oven it's all grated cheese; the oven melts it into one layer.
    const cover = on ? smooth(0.1, 0.75, b) * 0.96 : 0
    uniforms.uCover.value += (cover - uniforms.uCover.value) * Math.min(1, dt * 8)
    uniforms.uBake.value = b
    layer.current.visible = uniforms.uCover.value > 0.01
    if (on) lerpColor(uniforms.uCheese, CHEESES[cheese], 1 - Math.exp(-dt * 5))

    pieces.forEach((piece, index) => {
      const fall = t < 0 ? 0 : clamp01((t - piece.delay) / 0.55)
      const melt = smooth(0.08 + piece.meltAt * 0.35, 0.4 + piece.meltAt * 0.4, b)
      if (fall <= 0 || melt >= 0.999 || !on) {
        dummy.scale.setScalar(0)
      } else {
        const g = fall * fall
        dummy.position.set(piece.x + piece.driftX * (1 - g), piece.startY + (piece.y - piece.startY) * g - melt * 0.006, piece.z + piece.driftZ * (1 - g))
        dummy.rotation.set(piece.tilt * (1 - melt) + (1 - fall) * piece.spin, piece.yaw + (1 - fall) * piece.spin * 0.4, 0)
        dummy.scale.set(piece.length * (1 + melt * 0.3), 0.009 * (1 - melt * 0.8), piece.width * (1 + melt * 1.4))
      }
      dummy.updateMatrix()
      shreds.current.setMatrixAt(index, dummy.matrix)
    })
    shreds.current.instanceMatrix.needsUpdate = true
  })

  return (
    <group>
      <mesh ref={layer} rotation-x={-Math.PI / 2} position-y={BASE_Y + 0.004} scale={foot - 0.03} material={material} receiveShadow>
        <circleGeometry args={[1, 180]} />
      </mesh>
      <instancedMesh ref={shreds} args={[geometry, null, pieces.length]} castShadow receiveShadow frustumCulled={false}>
        <meshPhysicalMaterial color="#efe3c4" roughness={0.42} sheen={0.7} sheenColor="#fffaf0" clearcoat={0.2} clearcoatRoughness={0.5} />
      </instancedMesh>
    </group>
  )
}

function ToppingLayer({ id, leaving, bake, onLanded }) {
  const spec = toppingSpec(id)
  const points = useMemo(() => placements(id, spec), [id, spec])
  const geometry = useMemo(() => {
    if (spec.kind !== 'card') return spec.geometry
    const g = spec.geometry.clone()
    g.setAttribute('aVariant', new THREE.InstancedBufferAttribute(Float32Array.from(points.map((point) => point.variant)), 1))
    return g
  }, [spec, points])
  const ref = useRef()
  const addedAt = useRef(null)
  const leftAt = useRef(null)
  const landed = useRef(false)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const position = useMemo(() => new THREE.Vector3(), [])
  const middle = useMemo(() => new THREE.Vector3(), [])
  const end = useMemo(() => new THREE.Vector3(), [])
  const size = spec.size ?? 1

  useEffect(() => {
    points.forEach((point, index) => ref.current.setColorAt(index, point.tint))
    ref.current.instanceColor.needsUpdate = true
    if (spec.depth) ref.current.customDepthMaterial = spec.depth
  }, [points, spec])

  useFrame(({ clock }) => {
    const now = clock.elapsedTime
    if (addedAt.current == null) addedAt.current = now
    if (leaving && leftAt.current == null) leftAt.current = now
    const age = now - addedAt.current
    const b = bake.current
    if (!landed.current && age > 0.6) {
      landed.current = true
      onLanded?.()
    }

    points.forEach((point, index) => {
      const p = clamp01((age - point.delay) / 0.6)
      if (p <= 0) {
        dummy.scale.setScalar(0)
        dummy.updateMatrix()
        ref.current.setMatrixAt(index, dummy.matrix)
        return
      }
      const e = easeOutCubic(p)
      end.set(point.x, point.y - b * 0.004, point.z)
      middle.set((point.start.x + point.x) / 2, Math.max(point.start.y, point.y) + 0.35, (point.start.z + point.z) / 2)
      position.copy(point.start).multiplyScalar((1 - e) ** 2).addScaledVector(middle, 2 * (1 - e) * e).addScaledVector(end, e * e)

      // A little wobble as it settles.
      const since = age - point.delay - 0.6
      const settle = since > 0 && since < 0.8 ? Math.exp(-since * 7) * Math.sin(since * 26) * 0.12 : 0
      dummy.rotation.set(point.tiltX + (1 - e) * point.spin.x + settle, point.yaw + (1 - e) * point.spin.y, point.tiltZ + (1 - e) * point.spin.z - settle * 0.6)
      let scale = point.scale * size * (0.7 + 0.3 * e)

      if (leftAt.current != null) {
        const q = clamp01((now - leftAt.current - point.delay * 0.3) / 0.55)
        position.lerp(point.scatter, easeInCubic(q))
        dummy.rotation.x += q * point.spin.x * 0.4
        scale *= 1 - q
      }
      dummy.position.copy(position)
      dummy.scale.setScalar(Math.max(scale, 0.00001))
      dummy.updateMatrix()
      ref.current.setMatrixAt(index, dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true

    if (spec.uniforms) spec.uniforms.uBake.value = b
    else spec.material.color.copy(spec.color).lerp(spec.bakedColor, b)
  })

  return <instancedMesh ref={ref} args={[geometry, spec.material, points.length]} castShadow receiveShadow frustumCulled={false} />
}

// Keeps leaving toppings around long enough to fly off.
function Toppings({ toppings, bake }) {
  const [layers, setLayers] = useState([])
  const previous = useRef([])
  useEffect(() => {
    const added = toppings.filter((id) => !previous.current.includes(id))
    const removed = previous.current.filter((id) => !toppings.includes(id))
    previous.current = toppings
    if (added.length) sound.whoosh()
    if (removed.length) sound.pop()
    setLayers((current) => [
      ...current.map((layer) => (removed.includes(layer.id) ? { ...layer, leaving: true } : layer)),
      ...added.map((id) => ({ id, key: `${id}-${performance.now()}`, leaving: false })),
    ])
  }, [toppings.join('|')])

  useEffect(() => {
    if (!layers.some((layer) => layer.leaving)) return
    const timer = setTimeout(() => setLayers((current) => current.filter((layer) => !layer.leaving)), 1400)
    return () => clearTimeout(timer)
  }, [layers])

  return layers.map((layer) => <ToppingLayer key={layer.key} id={layer.id} leaving={layer.leaving} bake={bake} onLanded={sound.plop} />)
}

// Soft steam rising once it's out of the oven.
function Steam({ amount }) {
  const texture = useMemo(softDotTexture, [])
  const ref = useRef()
  const puffs = useMemo(() => {
    const random = rng(8)
    return Array.from({ length: 26 }, () => ({ x: (random() - 0.5) * 1.3, z: (random() - 0.5) * 1.3, offset: random(), size: 0.3 + random() * 0.4, sway: random() * 6 }))
  }, [])
  useFrame(({ clock }) => {
    ref.current.children.forEach((sprite, index) => {
      const puff = puffs[index]
      const t = (clock.elapsedTime * 0.3 + puff.offset) % 1
      sprite.position.set(puff.x + Math.sin(clock.elapsedTime * 0.8 + puff.sway) * 0.1, 0.15 + t * 1.5, puff.z)
      sprite.scale.setScalar(puff.size * (0.6 + t * 1.2))
      sprite.material.opacity = Math.sin(t * Math.PI) * 0.16 * amount.current
    })
  })
  return (
    <group ref={ref}>
      {puffs.map((_, index) => (
        <sprite key={index}>
          <spriteMaterial map={texture} transparent depthWrite={false} opacity={0} color="#ffffff" />
        </sprite>
      ))}
    </group>
  )
}

function Pizza({ build, bake, onBaked, keyLight }) {
  const group = useRef()
  const dough = useRef()
  const radius = SIZES_BY_ID[build.size ?? 'medium'].radius
  const { foot } = CRUSTS[build.crust]
  const scale = useRef(new Spring(0, 150, 13))
  const puff = useRef(new Spring(1, 260, 10))
  const crustSeen = useRef(build.crust)
  const bakeStart = useRef(null)
  const baked = useRef(false)
  const steam = useRef(0)
  const ovenLight = useRef()
  const uniforms = useMemo(() => ({ uBake: { value: 0 } }), [])
  const material = useMemo(() => doughMaterial(uniforms), [uniforms])
  const geometry = useMemo(() => doughGeometry(build.crust), [build.crust])
  const blob = useMemo(shadowBlobTexture, [])
  const [puffs, setPuffs] = useState(0)
  const warm = useMemo(() => new THREE.Color('#ffb070'), [])
  const daylight = useMemo(() => new THREE.Color('#fff6ec'), [])

  useEffect(() => {
    if (!build.size) return
    setPuffs((value) => value + 1)
    sound.slap()
  }, [Boolean(build.size)])

  useEffect(() => {
    if (crustSeen.current === build.crust) return
    crustSeen.current = build.crust
    puff.current.velocity = 5
    setPuffs((value) => value + 1)
    sound.slap()
  }, [build.crust])

  useEffect(() => {
    if (build.stage === 'baking') sound.oven()
  }, [build.stage])

  useFrame(({ clock }, dt) => {
    const step = Math.min(dt, 1 / 30)
    group.current.scale.setScalar(Math.max(0.0001, scale.current.step(build.size ? radius : 0, step)))
    dough.current.scale.y = puff.current.step(1, step)

    if (build.stage !== 'building' && bakeStart.current == null) bakeStart.current = clock.elapsedTime
    const t = bakeStart.current == null ? 0 : clock.elapsedTime - bakeStart.current
    bake.current = smooth(0.2, BAKE_SECONDS, t)
    uniforms.uBake.value = bake.current
    material.bumpScale = 0.4 + bake.current * 1.6
    const glow = Math.sin(clamp01(t / (BAKE_SECONDS + 0.6)) * Math.PI)
    ovenLight.current.intensity = glow * 5
    if (keyLight.current) keyLight.current.color.copy(daylight).lerp(warm, glow * 0.7)
    steam.current = smooth(BAKE_SECONDS - 0.6, BAKE_SECONDS + 0.8, t)
    if (!baked.current && t > BAKE_SECONDS + 0.5) {
      baked.current = true
      sound.ding()
      onBaked?.()
    }
  })

  return (
    <>
      <pointLight ref={ovenLight} position={[0, 0.9, 0.5]} color="#ff8a2a" intensity={0} distance={5} decay={1.5} />
      <group ref={group}>
        <mesh rotation-x={-Math.PI / 2} position={[0.05, 0.0015, 0.06]} renderOrder={1}>
          <circleGeometry args={[1.22, 96]} />
          <meshBasicMaterial map={blob} transparent depthWrite={false} color="#3b2414" />
        </mesh>
        <mesh ref={dough} geometry={geometry} material={material} castShadow receiveShadow />
        <Sauce sauce={build.sauce} foot={foot} bake={bake} />
        <Cheese cheese={build.cheese} foot={foot} bake={bake} />
        <Toppings toppings={build.toppings} bake={bake} />
      </group>
      <FlourPuff trigger={puffs} />
      <Steam amount={steam} />
      {build.stage !== 'building' && <Sparkles count={50} scale={[3, 1.4, 3]} position={[0, 0.6, 0]} size={3} speed={0.7} color="#ff9a3c" opacity={0.85} />}
    </>
  )
}

// Framing per step. The overlay's panels sit left, right and below, so the pizza is framed a little high.
const CAMERA = {
  base: { position: [0, 5.4, 4.6], look: [0, -0.45, 0.35] },
  sauce: { position: [0, 6.3, 3.4], look: [0, -0.55, 0.3] },
  cheese: { position: [0, 6.3, 3.4], look: [0, -0.55, 0.3] },
  toppings: { position: [0, 5.9, 3.9], look: [0, -0.55, 0.32] },
  bake: { position: [0, 4.7, 4.8], look: [0, -0.35, 0.3] },
}

function CameraRig({ step }) {
  const { camera, size } = useThree()
  const look = useRef(new THREE.Vector3(0, -0.45, 0.35))
  const goal = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }, dt) => {
    const shot = CAMERA[step]
    const t = clock.elapsedTime
    // Narrower screens pull back so the whole pizza stays in frame.
    const fit = Math.max(1, 1.65 / (size.width / size.height))
    goal.set(shot.position[0] * fit + Math.sin(t * 0.25) * 0.22, shot.position[1] * fit + Math.sin(t * 0.4) * 0.05, shot.position[2] * fit)
    const k = 1 - Math.exp(-dt * 2)
    camera.position.lerp(goal, k)
    look.current.lerp(goal.set(...shot.look), k)
    camera.lookAt(look.current)
  })
  return null
}

function Warmup() {
  useEffect(() => warmToppings(), [])
  return null
}

const aimAtCentre = (self) => self.lookAt(0, 0, 0)

export default function PizzaScene({ build, onBaked }) {
  const bake = useRef(0)
  const keyLight = useRef()
  const step = currentStep(build)
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: false, powerPreference: 'high-performance' }} camera={{ fov: 30, position: [0, 5.4, 4.6], near: 0.1, far: 60 }}>
      <color attach="background" args={['#f4efe4']} />
      <Warmup />
      <CameraRig step={step} />
      <ambientLight intensity={0.12} color="#fff2e6" />
      <directionalLight
        ref={keyLight}
        position={[-3.4, 7.2, 2.8]}
        intensity={2.1}
        color="#fff6ec"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.015}
        shadow-camera-left={-2.4}
        shadow-camera-right={2.4}
        shadow-camera-top={2.4}
        shadow-camera-bottom={-2.4}
        shadow-camera-near={1}
        shadow-camera-far={20}
      />
      <Environment resolution={512} frames={1}>
        <Lightformer form="rect" intensity={2.6} position={[-4, 6, 3]} scale={[7, 7, 1]} onUpdate={aimAtCentre} color="#fff8f0" />
        <Lightformer form="rect" intensity={0.7} position={[5, 3, 1]} scale={[6, 4, 1]} onUpdate={aimAtCentre} color="#fff1e4" />
        <Lightformer form="rect" intensity={1.1} position={[0, 9, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} color="#ffffff" />
        <Lightformer form="rect" intensity={0.9} position={[0, 3, -6]} scale={[10, 3, 1]} onUpdate={aimAtCentre} color="#ffe2c8" />
      </Environment>

      <Table />
      <PresentationControls global snap polar={[-0.12, 0.22]} azimuth={[-0.6, 0.6]} config={{ mass: 1, tension: 170, friction: 24 }}>
        <group rotation-y={-0.2}>
          <DoughBall visible={!build.size} />
          <Pizza build={build} bake={bake} onBaked={onBaked} keyLight={keyLight} />
        </group>
      </PresentationControls>

      <EffectComposer multisampling={4} enableNormalPass={false}>
        {!DEBUG.has('noao') && <N8AO aoRadius={0.22} distanceFalloff={0.45} intensity={2.2} quality="high" color="#2a1a14" />}
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      </EffectComposer>
    </Canvas>
  )
}
