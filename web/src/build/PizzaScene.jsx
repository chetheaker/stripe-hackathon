import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Lightformer, PresentationControls, Sparkles } from '@react-three/drei'
import * as THREE from 'three'

import { SIZES_BY_ID, currentStep } from './buildModel'
import { cheeseTextures, doughTextures, rng, sauceTexture, softDotTexture, woodTexture } from './textures'
import { placements, toppingSpec } from './toppings3d'
import { sound } from './sound'

const BAKE_SECONDS = 3.2
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

const SAUCE_COLORS = { tomato: '#b52a17', bbq: '#5c2210', garlic: '#f1e7cf' }
const CHEESE_COLORS = { mozzarella: '#f6ead0', vegan: '#f3e6b8' }

/* ---------- Materials that bake ---------- */

// Mixes a raw and a baked texture by uBake, and can reveal itself by uReveal.
const patchMaterial = (material, { baked, coverage, uniforms, reveal }) => {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { bakedMap: { value: baked }, coverageMap: { value: coverage ?? baked } })
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec2 vLocal;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xy;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uBake;\nuniform float uReveal;\nuniform sampler2D bakedMap;\nuniform sampler2D coverageMap;\nvarying vec2 vLocal;\nvoid main() {')
      .replace('#include <map_fragment>', `
        vec4 rawTexel = texture2D( map, vMapUv );
        vec4 bakedTexel = texture2D( bakedMap, vMapUv );
        diffuseColor *= mix( rawTexel, bakedTexel, uBake );
        ${reveal ?? ''}
      `)
  }
  return material
}

// Sauce spreads out in a spiral, like a ladle working from the middle.
const SAUCE_REVEAL = `
  float r = length( vLocal );
  float a = atan( vLocal.y, vLocal.x ) / 6.28318 + 0.5;
  float edge = 0.95 + 0.025 * sin( a * 6.28318 * 7.0 ) + 0.018 * sin( a * 6.28318 * 13.0 + 1.3 );
  if ( r > edge ) discard;
  float spiral = r * 0.8 + fract( a - r * 2.2 ) * 0.2;
  if ( spiral > uReveal * 1.02 ) discard;
`

// Cheese melts in: lower the coverage threshold and more blobs appear.
const CHEESE_REVEAL = `
  if ( texture2D( coverageMap, vMapUv ).r < 1.0 - uReveal * 0.97 ) discard;
`

/* ---------- Dough ---------- */

const RIM = { classic: 0.07, stuffed: 0.1, gluten_free: 0.055 }

const doughGeometry = (crust) => {
  const rim = RIM[crust]
  const cx = 1 - rim
  const cy = rim + 0.008
  const points = []
  for (let i = 0; i <= 5; i++) points.push(new THREE.Vector2((cx * i) / 5, 0))
  for (let i = 1; i <= 24; i++) {
    const angle = -Math.PI / 2 + (i / 24) * Math.PI * 1.5
    points.push(new THREE.Vector2(cx + Math.cos(angle) * rim, cy + Math.sin(angle) * rim * 1.05))
  }
  // Down off the rim quickly, then flat to the middle so sauce and cheese sit on it.
  const inner = cx - rim
  points.push(new THREE.Vector2(inner - 0.015, cy * 0.72 + 0.014))
  points.push(new THREE.Vector2(inner - 0.04, 0.052))
  for (let i = 1; i <= 4; i++) points.push(new THREE.Vector2((inner - 0.04) * (1 - i / 4), 0.05))
  points[points.length - 1].x = 0.0001
  return new THREE.LatheGeometry(points, 96)
}

/* ---------- Scene pieces ---------- */

function Board() {
  const texture = useMemo(woodTexture, [])
  return (
    <group position={[0, -0.05, 0]}>
      <mesh receiveShadow castShadow>
        <cylinderGeometry args={[1.72, 1.74, 0.08, 96]} />
        <meshStandardMaterial map={texture} roughness={0.72} color="#e6c39b" />
      </mesh>
      <mesh position={[-1.85, 0, -1.85]} rotation={[0, Math.PI / 4, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.36, 0.07, 1.5]} />
        <meshStandardMaterial map={texture} roughness={0.72} color="#d9b48a" />
      </mesh>
    </group>
  )
}

function DoughBall({ visible }) {
  const ref = useRef()
  const spring = useRef(new Spring(1, 140, 12))
  useFrame((state, dt) => {
    const s = spring.current.step(visible ? 1 : 0, Math.min(dt, 1 / 30))
    const bob = Math.sin(state.clock.elapsedTime * 2.2) * 0.03
    ref.current.visible = s > 0.02
    ref.current.scale.set(0.55 * (2 - s), 0.38 * s, 0.55 * (2 - s))
    ref.current.position.y = 0.18 * s + bob * s
  })
  return (
    <mesh ref={ref} castShadow>
      <sphereGeometry args={[1, 48, 32]} />
      <meshPhysicalMaterial color="#ecc994" roughness={0.65} sheen={0.6} sheenColor="#fff0d0" />
    </mesh>
  )
}

// A burst of flour when the base slaps down or the crust changes.
function FlourPuff({ trigger }) {
  const ref = useRef()
  const start = useRef(-10)
  const seen = useRef(trigger)
  const count = 60
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const particles = useMemo(() => {
    const random = rng(99)
    return Array.from({ length: count }, () => {
      const angle = random() * Math.PI * 2
      return { angle, speed: 0.8 + random() * 1.4, lift: 0.4 + random() * 0.9, size: 0.012 + random() * 0.02 }
    })
  }, [])
  useFrame(({ clock }) => {
    if (seen.current !== trigger) {
      seen.current = trigger
      start.current = clock.elapsedTime
    }
    const t = clock.elapsedTime - start.current
    const life = clamp01(t / 0.9)
    particles.forEach((particle, index) => {
      const travel = easeOutCubic(life)
      dummy.position.set(Math.cos(particle.angle) * (1.05 + travel * particle.speed * 0.6), 0.05 + Math.sin(life * Math.PI) * particle.lift * 0.4, Math.sin(particle.angle) * (1.05 + travel * particle.speed * 0.6))
      dummy.scale.setScalar(life >= 1 ? 0 : particle.size * (1 - life) * 6)
      dummy.updateMatrix()
      ref.current.setMatrixAt(index, dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={ref} args={[null, null, count]} frustumCulled={false}>
      <sphereGeometry args={[1, 8, 6]} />
      <meshStandardMaterial color="#fffaf0" roughness={1} transparent opacity={0.85} />
    </instancedMesh>
  )
}

function Sauce({ sauce, bake }) {
  const uniforms = useMemo(() => ({ uBake: { value: 0 }, uReveal: { value: 0 } }), [])
  const material = useMemo(() => {
    const map = sauceTexture()
    return patchMaterial(new THREE.MeshPhysicalMaterial({ map, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.25, color: SAUCE_COLORS.tomato }), { baked: map, uniforms, reveal: SAUCE_REVEAL })
  }, [uniforms])
  const target = useMemo(() => new THREE.Color(), [])
  const ref = useRef()

  useFrame((_, dt) => {
    const reveal = uniforms.uReveal
    reveal.value = sauce ? Math.min(1, reveal.value + dt / 1.4) : Math.max(0, reveal.value - dt * 2)
    ref.current.visible = reveal.value > 0.001
    if (sauce) material.color.lerp(target.set(SAUCE_COLORS[sauce]), 1 - Math.exp(-dt * 6))
    uniforms.uBake.value = bake.current
    material.roughness = 0.32 + bake.current * 0.25
  })
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.052} material={material} receiveShadow>
      <circleGeometry args={[0.81, 128]} />
    </mesh>
  )
}

function Cheese({ cheese, bake }) {
  const uniforms = useMemo(() => ({ uBake: { value: 0 }, uReveal: { value: 0 } }), [])
  const material = useMemo(() => {
    const { raw, baked, coverage } = cheeseTextures()
    return patchMaterial(new THREE.MeshPhysicalMaterial({ map: raw, roughness: 0.5, sheen: 0.6, color: CHEESE_COLORS.mozzarella }), { baked, coverage, uniforms, reveal: CHEESE_REVEAL })
  }, [uniforms])
  const shreds = useRef()
  const layer = useRef()
  const startedAt = useRef(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const target = useMemo(() => new THREE.Color(), [])
  const pieces = useMemo(() => {
    const random = rng(321)
    return Array.from({ length: 240 }, () => {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * 0.74
      return {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        y: 0.062 + random() * 0.01,
        startY: 1.6 + random() * 1.4,
        drift: (random() - 0.5) * 0.4,
        delay: random() * 0.9,
        yaw: random() * Math.PI * 2,
        spin: (random() - 0.5) * 12,
        length: 0.5 + random() * 0.7,
      }
    })
  }, [])
  const on = cheese && cheese !== 'none'

  useFrame(({ clock }, dt) => {
    const now = clock.elapsedTime
    if (on && startedAt.current == null) startedAt.current = now
    if (!on) startedAt.current = null
    const t = startedAt.current == null ? -1 : now - startedAt.current
    const melt = smooth(0.05, 0.7, bake.current)

    uniforms.uReveal.value = on ? Math.max(uniforms.uReveal.value, Math.min(1, smooth(0.5, 1.9, t) * 0.42 + melt * 0.4)) : Math.max(0, uniforms.uReveal.value - dt * 2)
    uniforms.uBake.value = bake.current
    layer.current.visible = uniforms.uReveal.value > 0.001
    if (on) material.color.lerp(target.set(CHEESE_COLORS[cheese]), 1 - Math.exp(-dt * 6))

    pieces.forEach((piece, index) => {
      const fall = t < 0 ? 0 : clamp01((t - piece.delay) / 0.5)
      if (fall <= 0 || melt >= 1) {
        dummy.scale.setScalar(0)
      } else {
        const g = fall * fall
        dummy.position.set(piece.x + piece.drift * (1 - fall), piece.startY + (piece.y - piece.startY) * g, piece.z)
        dummy.rotation.set(Math.PI / 2 + (1 - fall) * piece.spin, piece.yaw + (1 - fall) * piece.spin * 0.5, 0)
        const squash = 1 - melt
        dummy.scale.set(0.008 * (1 + melt * 2), 0.03 * piece.length * squash + 0.0001, 0.008 * squash + 0.0001)
      }
      dummy.updateMatrix()
      shreds.current.setMatrixAt(index, dummy.matrix)
    })
    shreds.current.instanceMatrix.needsUpdate = true
  })

  return (
    <group>
      <mesh ref={layer} rotation-x={-Math.PI / 2} position-y={0.058} material={material} receiveShadow>
        <circleGeometry args={[0.79, 128]} />
      </mesh>
      <instancedMesh ref={shreds} args={[null, null, pieces.length]} castShadow frustumCulled={false}>
        <capsuleGeometry args={[1, 1, 3, 6]} />
        <meshStandardMaterial color={cheese === 'vegan' ? '#f3e6b8' : '#f6ead0'} roughness={0.55} />
      </instancedMesh>
    </group>
  )
}

function ToppingLayer({ id, leaving, bake, onLanded }) {
  const spec = toppingSpec(id)
  const points = useMemo(() => placements(id, spec), [id, spec])
  const ref = useRef()
  const addedAt = useRef(null)
  const leftAt = useRef(null)
  const landed = useRef(false)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const position = useMemo(() => new THREE.Vector3(), [])
  const middle = useMemo(() => new THREE.Vector3(), [])
  const end = useMemo(() => new THREE.Vector3(), [])

  useFrame(({ clock }) => {
    const now = clock.elapsedTime
    if (addedAt.current == null) addedAt.current = now
    if (leaving && leftAt.current == null) leftAt.current = now
    const age = now - addedAt.current

    if (!landed.current && age > 0.62) {
      landed.current = true
      onLanded?.()
    }

    points.forEach((point, index) => {
      const p = clamp01((age - point.delay) / 0.62)
      if (p <= 0) {
        dummy.scale.setScalar(0)
        dummy.updateMatrix()
        ref.current.setMatrixAt(index, dummy.matrix)
        return
      }
      const e = easeOutCubic(p)
      end.set(point.x, point.y, point.z)
      middle.set((point.start.x + point.x) / 2, Math.max(point.start.y, point.y) + 0.6, (point.start.z + point.z) / 2)
      // Quadratic Bézier from the start, over the middle, onto the pizza.
      position.copy(point.start).multiplyScalar((1 - e) ** 2).addScaledVector(middle, 2 * (1 - e) * e).addScaledVector(end, e * e)
      dummy.rotation.set(point.tilt + (1 - e) * point.spin.x, point.yaw + (1 - e) * point.spin.y, (1 - e) * point.spin.z)

      // A little squash as it lands.
      const since = age - point.delay - 0.62
      let squash = 1
      if (since > 0 && since < 0.7) squash = 1 - 0.32 * Math.exp(-since * 8) * Math.cos(since * 24)
      let scale = 0.55 + 0.45 * e

      if (leftAt.current != null) {
        const q = clamp01((now - leftAt.current - point.delay * 0.35) / 0.55)
        const lift = easeInCubic(q)
        position.lerp(point.scatter, lift)
        dummy.rotation.x += q * point.spin.x * 0.3
        scale *= 1 - q
      }
      dummy.position.copy(position)
      dummy.scale.set(scale / Math.sqrt(squash), scale * squash, scale / Math.sqrt(squash))
      dummy.updateMatrix()
      ref.current.setMatrixAt(index, dummy.matrix)
    })
    ref.current.instanceMatrix.needsUpdate = true
    spec.material.color.copy(spec.color).lerp(spec.bakedColor, bake.current)
  })

  return <instancedMesh ref={ref} args={[spec.geometry, spec.material, points.length]} castShadow receiveShadow frustumCulled={false} />
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
    return Array.from({ length: 22 }, () => ({ x: (random() - 0.5) * 1.2, z: (random() - 0.5) * 1.2, offset: random() * 3, size: 0.25 + random() * 0.35, sway: random() * 6 }))
  }, [])
  useFrame(({ clock }) => {
    ref.current.children.forEach((sprite, index) => {
      const puff = puffs[index]
      const t = (clock.elapsedTime * 0.35 + puff.offset) % 1
      sprite.position.set(puff.x + Math.sin(clock.elapsedTime + puff.sway) * 0.08, 0.15 + t * 1.6, puff.z)
      sprite.scale.setScalar(puff.size * (0.6 + t))
      sprite.material.opacity = Math.sin(t * Math.PI) * 0.22 * amount.current
    })
  })
  return (
    <group ref={ref}>
      {puffs.map((_, index) => (
        <sprite key={index}>
          <spriteMaterial map={texture} transparent depthWrite={false} opacity={0} color="#fff6ea" />
        </sprite>
      ))}
    </group>
  )
}

function Pizza({ build, bake, onBaked }) {
  const group = useRef()
  const dough = useRef()
  const radius = SIZES_BY_ID[build.size ?? 'medium'].radius
  const scale = useRef(new Spring(0, 160, 12))
  const puff = useRef(new Spring(1, 260, 10))
  const crustSeen = useRef(build.crust)
  const bakeStart = useRef(null)
  const baked = useRef(false)
  const steam = useRef(0)
  const ovenLight = useRef()
  const textures = useMemo(doughTextures, [])
  const uniforms = useMemo(() => ({ uBake: { value: 0 }, uReveal: { value: 1 } }), [])
  const doughMaterial = useMemo(() => patchMaterial(new THREE.MeshPhysicalMaterial({ map: textures.raw, roughness: 0.78, sheen: 0.5, sheenColor: '#fff2d6' }), { baked: textures.baked, uniforms }), [textures, uniforms])
  const geometry = useMemo(() => doughGeometry(build.crust), [build.crust])
  const [puffs, setPuffs] = useState(0)

  useEffect(() => {
    if (!build.size) return
    setPuffs((value) => value + 1)
    sound.slap()
  }, [Boolean(build.size)])

  useEffect(() => {
    if (crustSeen.current === build.crust) return
    crustSeen.current = build.crust
    puff.current.velocity = 6
    setPuffs((value) => value + 1)
    sound.slap()
  }, [build.crust])

  useEffect(() => {
    if (build.stage === 'baking') sound.oven()
  }, [build.stage])

  useFrame(({ clock }, dt) => {
    const step = Math.min(dt, 1 / 30)
    const s = Math.max(0.0001, scale.current.step(build.size ? radius : 0, step))
    const y = puff.current.step(1, step)
    group.current.scale.set(s, s, s)
    dough.current.scale.y = y

    if (build.stage !== 'building' && bakeStart.current == null) bakeStart.current = clock.elapsedTime
    const t = bakeStart.current == null ? 0 : clock.elapsedTime - bakeStart.current
    bake.current = smooth(0.2, BAKE_SECONDS, t)
    uniforms.uBake.value = bake.current
    ovenLight.current.intensity = Math.sin(clamp01(t / (BAKE_SECONDS + 0.6)) * Math.PI) * 9
    steam.current = smooth(BAKE_SECONDS - 0.6, BAKE_SECONDS + 0.8, t)
    if (!baked.current && t > BAKE_SECONDS + 0.5) {
      baked.current = true
      sound.ding()
      onBaked?.()
    }
  })

  return (
    <>
      <pointLight ref={ovenLight} position={[0, 0.9, 0.4]} color="#ff7a1f" intensity={0} distance={6} decay={1.4} />
      <group ref={group}>
        <mesh ref={dough} geometry={geometry} material={doughMaterial} castShadow receiveShadow />
        <Sauce sauce={build.sauce} bake={bake} />
        <Cheese cheese={build.cheese} bake={bake} />
        <Toppings toppings={build.toppings} bake={bake} />
      </group>
      <FlourPuff trigger={puffs} />
      <Steam amount={steam} />
      {build.stage !== 'building' && <Sparkles count={60} scale={[3, 1.6, 3]} position={[0, 0.7, 0]} size={4} speed={0.8} color="#ffb04a" opacity={0.9} />}
    </>
  )
}

const CAMERA = {
  base: { position: [0, 5.1, 6.7], look: [0, -0.5, 0.2] },
  sauce: { position: [0, 6.4, 4.9], look: [0, -0.65, 0.2] },
  cheese: { position: [0, 6.4, 4.9], look: [0, -0.65, 0.2] },
  toppings: { position: [0, 5.6, 5.5], look: [0, -0.6, 0.2] },
  bake: { position: [0, 4.0, 6.4], look: [0, -0.35, 0.2] },
}

function CameraRig({ step }) {
  const { camera, size } = useThree()
  const look = useRef(new THREE.Vector3(0, -0.55, 0.2))
  const goal = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }, dt) => {
    const shot = CAMERA[step]
    const t = clock.elapsedTime
    // Narrower screens pull back so the whole pizza stays in frame.
    const fit = Math.max(1, 1.65 / (size.width / size.height))
    goal.set(shot.position[0] * fit + Math.sin(t * 0.3) * 0.3, shot.position[1] * fit + Math.sin(t * 0.45) * 0.08, shot.position[2] * fit)
    const k = 1 - Math.exp(-dt * 2.2)
    camera.position.lerp(goal, k)
    look.current.lerp(goal.set(...shot.look), k)
    camera.lookAt(look.current)
  })
  return null
}

export default function PizzaScene({ build, onBaked }) {
  const bake = useRef(0)
  const step = currentStep(build)
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, alpha: true }} camera={{ fov: 30, position: [0, 5.6, 7.4] }}>
      <CameraRig step={step} />
      <ambientLight intensity={0.15} color="#ffe2c0" />
      <directionalLight
        position={[2.5, 6, 3]}
        intensity={1.7}
        color="#ffeacc"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-2.6}
        shadow-camera-right={2.6}
        shadow-camera-top={2.6}
        shadow-camera-bottom={-2.6}
      />
      <spotLight position={[-3.5, 3, -4]} intensity={40} angle={0.6} penumbra={1} color="#ffae6b" />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={1.1} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[8, 8, 1]} color="#fff4e6" />
        <Lightformer form="rect" intensity={0.9} position={[-5, 2, 1]} rotation-y={Math.PI / 2} scale={[6, 3, 1]} color="#ffcf9e" />
        <Lightformer form="rect" intensity={0.9} position={[5, 2, -1]} rotation-y={-Math.PI / 2} scale={[6, 3, 1]} color="#ffe2c2" />
        <Lightformer form="ring" intensity={0.8} position={[0, 2, 5]} scale={2} color="#ffffff" />
      </Environment>

      <PresentationControls global snap polar={[-0.15, 0.25]} azimuth={[-0.7, 0.7]} config={{ mass: 1, tension: 170, friction: 22 }}>
        <group rotation-y={-0.25}>
          <Board />
          <DoughBall visible={!build.size} />
          <Pizza build={build} bake={bake} onBaked={onBaked} />
        </group>
      </PresentationControls>
      <ContactShadows position={[0, -0.095, 0]} scale={7} blur={2.6} far={2} opacity={0.55} resolution={512} color="#2a1405" />
    </Canvas>
  )
}
