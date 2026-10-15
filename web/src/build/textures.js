import * as THREE from 'three'

/*
  Procedural textures, painted once on canvases. Slices (mushroom, olive,
  jalapeño…) are drawn top-down with alpha, four variants side by side, and
  rendered as thin cut-out cards so their edges are irregular like real food.
*/

export const rng = (seed) => {
  let value = seed % 2147483647
  if (value <= 0) value += 2147483646
  return () => {
    value = (value * 16807) % 2147483647
    return (value - 1) / 2147483646
  }
}

// Value noise with a fixed lattice, smooth and cheap.
const LATTICE = (() => {
  const random = rng(1234)
  return Float32Array.from({ length: 256 * 256 }, () => random())
})()
const lattice = (x, y) => LATTICE[((y & 255) << 8) | (x & 255)]
const fade = (t) => t * t * (3 - 2 * t)
export const noise2 = (x, y) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = fade(x - xi)
  const yf = fade(y - yi)
  const a = lattice(xi, yi)
  const b = lattice(xi + 1, yi)
  const c = lattice(xi, yi + 1)
  const d = lattice(xi + 1, yi + 1)
  const top = a + (b - a) * xf
  return top + ((c + (d - c) * xf) - top) * yf
}
export const fbm2 = (x, y, octaves = 4) => {
  let sum = 0
  let amp = 0.5
  for (let i = 0; i < octaves; i++) {
    sum += amp * (noise2(x, y) * 2 - 1)
    x = x * 2.03 + 17.1
    y = y * 2.03 + 3.7
    amp *= 0.5
  }
  return sum
}

const makeCanvas = (width, height = width) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const toTexture = (canvas, { srgb = true } = {}) => {
  const texture = new THREE.CanvasTexture(canvas)
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

// Multiplies colour by fbm noise wherever something is drawn, for organic variation.
const grain = (ctx, { amount = 0.18, scale = 0.04, seed = 0, octaves = 4 } = {}) => {
  const { width, height } = ctx.canvas
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] === 0) continue
      const n = 1 + amount * fbm2(x * scale + seed, y * scale + seed * 1.7, octaves)
      data[i] = Math.min(255, data[i] * n)
      data[i + 1] = Math.min(255, data[i + 1] * n)
      data[i + 2] = Math.min(255, data[i + 2] * n)
    }
  }
  ctx.putImageData(image, 0, 0)
}

const radial = (ctx, x, y, r0, r1, stops) => {
  const gradient = ctx.createRadialGradient(x, y, r0, x, y, r1)
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color))
  return gradient
}

// Paints `count` variants into one strip atlas, each cell `cell` px square.
const atlas = (count, cell, paint) => {
  const canvas = makeCanvas(cell * count, cell)
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < count; i++) {
    ctx.save()
    ctx.translate(i * cell, 0)
    ctx.beginPath()
    ctx.rect(0, 0, cell, cell)
    ctx.clip()
    paint(ctx, cell, rng(101 + i * 37), i)
    ctx.restore()
  }
  grain(ctx, { amount: 0.16, scale: 0.05, seed: count })
  return toTexture(canvas)
}

const wobblyCircle = (ctx, cx, cy, r, random, wobble = 0.04, points = 48) => {
  const phase = random() * 10
  ctx.beginPath()
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2
    const rr = r * (1 + wobble * Math.sin(a * 3 + phase) + wobble * 0.6 * Math.sin(a * 7 + phase * 2))
    const x = cx + Math.cos(a) * rr
    const y = cy + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/* ---------- Slices ---------- */

export const mushroomAtlas = () => atlas(4, 256, (ctx, s, random) => {
  const capW = s * (0.4 + random() * 0.05)
  const capH = s * (0.3 + random() * 0.06)
  const stemW = s * (0.12 + random() * 0.05)
  const stemH = s * (0.26 + random() * 0.08)
  const cx = s / 2
  const capY = s * 0.52
  const path = new Path2D()
  path.moveTo(cx - stemW, capY)
  path.bezierCurveTo(cx - capW * 1.05, capY + s * 0.02, cx - capW * 1.1, capY - capH * 1.1, cx, capY - capH)
  path.bezierCurveTo(cx + capW * 1.1, capY - capH * 1.1, cx + capW * 1.05, capY + s * 0.02, cx + stemW, capY)
  path.bezierCurveTo(cx + stemW * 0.9, capY + stemH * 0.5, cx + stemW * 1.25, capY + stemH, cx + stemW * 1.15, capY + stemH)
  path.lineTo(cx - stemW * 1.15, capY + stemH)
  path.bezierCurveTo(cx - stemW * 1.25, capY + stemH, cx - stemW * 0.9, capY + stemH * 0.5, cx - stemW, capY)
  path.closePath()
  ctx.fillStyle = radial(ctx, cx, capY, 0, capW * 1.2, [[0, '#e3d4b4'], [1, '#cdb48c']])
  ctx.fill(path)
  ctx.save()
  ctx.clip(path)
  // Gills: a darker crescent under the cap with fine lines.
  ctx.fillStyle = 'rgba(160, 128, 92, 0.55)'
  ctx.beginPath()
  ctx.ellipse(cx, capY - s * 0.01, capW * 0.92, s * 0.06, 0, 0, Math.PI)
  ctx.fill()
  ctx.strokeStyle = 'rgba(110, 84, 58, 0.35)'
  ctx.lineWidth = 1
  for (let i = 0; i < 40; i++) {
    const x = cx - capW * 0.9 + (i / 40) * capW * 1.8
    ctx.beginPath()
    ctx.moveTo(x, capY - s * 0.005)
    ctx.lineTo(x + (x - cx) * 0.08, capY + s * 0.045)
    ctx.stroke()
  }
  // Brown skin round the cap edge.
  ctx.lineWidth = s * 0.04
  ctx.strokeStyle = '#6f4e30'
  ctx.stroke(path)
  ctx.lineWidth = s * 0.09
  ctx.strokeStyle = 'rgba(140, 100, 62, 0.4)'
  ctx.stroke(path)
  // Fibres down the stem.
  ctx.strokeStyle = 'rgba(170, 140, 104, 0.25)'
  for (let i = 0; i < 10; i++) {
    const x = cx - stemW * 0.8 + (i / 10) * stemW * 1.6
    ctx.lineWidth = 1 + random()
    ctx.beginPath()
    ctx.moveTo(x, capY + s * 0.04)
    ctx.lineTo(x + (random() - 0.5) * 4, capY + stemH)
    ctx.stroke()
  }
  ctx.restore()
})

export const oliveAtlas = () => atlas(4, 128, (ctx, s, random) => {
  const cx = s / 2
  const r = s * (0.38 + random() * 0.05)
  wobblyCircle(ctx, cx, cx, r, random, 0.05)
  ctx.fillStyle = '#211a1f'
  ctx.fill()
  ctx.lineWidth = s * 0.05
  ctx.strokeStyle = '#3c2d36'
  ctx.stroke()
  // The cut face is a touch lighter and purple.
  ctx.fillStyle = radial(ctx, cx, cx, r * 0.35, r, [[0, 'rgba(72, 48, 64, 0.0)'], [0.6, 'rgba(72, 48, 64, 0.6)'], [1, 'rgba(30, 22, 28, 0)']])
  ctx.beginPath()
  ctx.arc(cx, cx, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  wobblyCircle(ctx, cx + (random() - 0.5) * 4, cx + (random() - 0.5) * 4, r * (0.38 + random() * 0.06), random, 0.06)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
})

export const jalapenoAtlas = () => atlas(4, 192, (ctx, s, random) => {
  const cx = s / 2
  const r = s * (0.4 + random() * 0.04)
  wobblyCircle(ctx, cx, cx, r, random, 0.06)
  ctx.fillStyle = '#23441a'
  ctx.fill()
  wobblyCircle(ctx, cx, cx, r * 0.86, random, 0.05)
  ctx.fillStyle = radial(ctx, cx, cx, r * 0.4, r * 0.86, [[0, '#c9d49a'], [0.7, '#8fa95a'], [1, '#5d7d34']])
  ctx.fill()
  // Pith and seeds.
  wobblyCircle(ctx, cx, cx, r * 0.5, random, 0.12)
  ctx.fillStyle = '#e7ecc8'
  ctx.fill()
  const seeds = 6 + Math.floor(random() * 4)
  for (let i = 0; i < seeds; i++) {
    const a = (i / seeds) * Math.PI * 2 + random() * 0.4
    const d = r * (0.22 + random() * 0.18)
    ctx.save()
    ctx.translate(cx + Math.cos(a) * d, cx + Math.sin(a) * d)
    ctx.rotate(a)
    ctx.beginPath()
    ctx.ellipse(0, 0, s * 0.045, s * 0.03, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#f2ead0'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(150, 140, 90, 0.7)'
    ctx.stroke()
    ctx.restore()
  }
  if (random() > 0.5) {
    ctx.globalCompositeOperation = 'destination-out'
    wobblyCircle(ctx, cx, cx, r * 0.16, random, 0.2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
})

const arc = (ctx, cx, cy, radius, start, sweep, width, color) => {
  ctx.lineCap = 'round'
  ctx.lineWidth = width
  ctx.strokeStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, radius, start, start + sweep)
  ctx.stroke()
}

export const pepperAtlas = () => atlas(4, 192, (ctx, s, random) => {
  const width = s * (0.085 + random() * 0.03)
  const sweep = 1.4 + random() * 1.2
  const start = -Math.PI / 2 - sweep / 2 + (random() - 0.5) * 0.4
  const radius = s * (0.3 + random() * 0.06)
  const cy = s / 2 + s * 0.12
  arc(ctx, s / 2, cy, radius, start, sweep, width, '#246d18')
  arc(ctx, s / 2, cy, radius - width * 0.12, start + 0.04, sweep - 0.08, width * 0.6, '#5f9f36')
  arc(ctx, s / 2, cy, radius - width * 0.28, start + 0.06, sweep - 0.12, width * 0.2, '#9cc870')
})

export const onionAtlas = () => atlas(4, 192, (ctx, s, random) => {
  const rings = 1 + Math.floor(random() * 2)
  for (let i = 0; i < rings; i++) {
    const radius = s * (0.36 - i * 0.07)
    const sweep = 1.2 + random() * 1.4
    const start = -Math.PI / 2 - sweep / 2 + (random() - 0.5) * 0.6
    const cy = s / 2 + s * 0.12
    arc(ctx, s / 2, cy, radius, start, sweep, s * 0.05, '#f3e0ea')
    arc(ctx, s / 2, cy, radius + s * 0.019, start, sweep, s * 0.018, '#7e2a69')
  }
})

export const hamAtlas = () => atlas(4, 192, (ctx, s, random) => {
  const w = s * (0.32 + random() * 0.06)
  ctx.save()
  ctx.translate(s / 2, s / 2)
  ctx.rotate((random() - 0.5) * 0.6)
  ctx.beginPath()
  const corners = [[-w, -w * 0.85], [w * 0.95, -w], [w, w * 0.9], [-w * 0.9, w]]
  corners.forEach(([x, y], i) => {
    const [nx, ny] = corners[(i + 1) % 4]
    if (i === 0) ctx.moveTo(x, y)
    ctx.quadraticCurveTo((x + nx) / 2 + (random() - 0.5) * w * 0.25, (y + ny) / 2 + (random() - 0.5) * w * 0.25, nx, ny)
  })
  ctx.closePath()
  ctx.fillStyle = '#e6a29b'
  ctx.fill()
  ctx.lineWidth = s * 0.03
  ctx.strokeStyle = '#d0837b'
  ctx.stroke()
  ctx.clip()
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(250, 214, 206, ${0.3 + random() * 0.4})`
    ctx.beginPath()
    ctx.ellipse((random() - 0.5) * w * 1.8, (random() - 0.5) * w * 1.8, 2 + random() * 9, 1 + random() * 4, random() * 3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
})

export const pineappleAtlas = () => atlas(4, 192, (ctx, s, random) => {
  ctx.save()
  ctx.translate(s / 2, s / 2)
  ctx.rotate((random() - 0.5) * 0.8)
  const w = s * (0.3 + random() * 0.05)
  const h = s * (0.2 + random() * 0.04)
  ctx.beginPath()
  ctx.moveTo(-w, h)
  ctx.lineTo(w, h)
  ctx.quadraticCurveTo(w * 0.8, -h * 0.2, w * 0.45, -h)
  ctx.lineTo(-w * 0.45, -h)
  ctx.quadraticCurveTo(-w * 0.8, -h * 0.2, -w, h)
  ctx.closePath()
  ctx.fillStyle = '#f2cd4a'
  ctx.fill()
  ctx.clip()
  ctx.strokeStyle = 'rgba(214, 160, 36, 0.55)'
  for (let i = 0; i < 26; i++) {
    const x = -w + (i / 26) * w * 2
    ctx.lineWidth = 1 + random() * 1.5
    ctx.beginPath()
    ctx.moveTo(x, h)
    ctx.lineTo(x * 0.45 + (random() - 0.5) * 4, -h)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(255, 240, 170, 0.45)'
  ctx.fillRect(-w, h * 0.55, w * 2, h * 0.5)
  ctx.restore()
})

const leafHalfWidth = (t, width, lobes, phase) => {
  let x = width * Math.sin(Math.PI * t ** 0.85) * (1 - 0.2 * t)
  if (lobes) x *= 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * lobes + phase))
  return x
}

const leaf = (ctx, s, random, { length, width, lobes, color, rib }) => {
  ctx.save()
  ctx.translate(s / 2, s / 2)
  ctx.rotate((random() - 0.5) * 0.5)
  const L = s * length
  const W = s * width
  const outline = new Path2D()
  const steps = 32
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const y = L / 2 - t * L
    const x = leafHalfWidth(t, W, lobes, 0)
    if (i === 0) outline.moveTo(x, y)
    else outline.lineTo(x, y)
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps
    outline.lineTo(-leafHalfWidth(t, W, lobes, 0.4), L / 2 - t * L)
  }
  outline.closePath()
  ctx.fillStyle = color
  ctx.fill(outline)
  ctx.save()
  ctx.clip(outline)
  ctx.fillStyle = radial(ctx, -W * 0.3, -L * 0.1, 0, L * 0.6, [[0, 'rgba(255,255,220,0.18)'], [1, 'rgba(0,0,0,0.12)']])
  ctx.fillRect(-s, -s, s * 2, s * 2)
  ctx.strokeStyle = rib
  ctx.lineWidth = s * 0.012
  ctx.beginPath()
  ctx.moveTo(0, L / 2 + 6)
  ctx.lineTo(0, -L / 2)
  ctx.stroke()
  ctx.lineWidth = s * 0.006
  for (let i = 1; i < 8; i++) {
    const y = L / 2 - (i / 8) * L
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(W * 0.4, y - L * 0.04, W, y - L * 0.12)
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(-W * 0.4, y - L * 0.04, -W, y - L * 0.12)
    ctx.stroke()
  }
  ctx.restore()
  ctx.lineWidth = s * 0.012
  ctx.strokeStyle = 'rgba(20, 50, 15, 0.4)'
  ctx.stroke(outline)
  ctx.restore()
}

export const basilAtlas = () => atlas(4, 256, (ctx, s, random) => {
  leaf(ctx, s, random, { length: 0.78, width: 0.24 + random() * 0.05, color: '#2f8a2c', rib: 'rgba(170, 220, 140, 0.55)' })
})

export const rocketAtlas = () => atlas(4, 256, (ctx, s, random) => {
  leaf(ctx, s, random, { length: 0.88, width: 0.16, lobes: 3 + Math.floor(random() * 2), color: '#3f7428', rib: 'rgba(190, 220, 150, 0.6)' })
})

/* ---------- Surfaces for 3D chunks ---------- */

const surface = (size, paint) => {
  const canvas = makeCanvas(size)
  paint(canvas.getContext('2d'), size)
  return toTexture(canvas)
}

const speckle = (ctx, size, count, colors, radius, random) => {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(random() * colors.length)]
    ctx.beginPath()
    ctx.arc(random() * size, random() * size, radius[0] + random() * radius[1], 0, Math.PI * 2)
    ctx.fill()
  }
}

export const beefSurface = () => surface(256, (ctx, size) => {
  ctx.fillStyle = '#5b2c1b'
  ctx.fillRect(0, 0, size, size)
  speckle(ctx, size, 900, ['#7a3a22', '#3a1a10', '#8e2a14', '#a5481f'], [0.5, 2.2], rng(5))
  grain(ctx, { amount: 0.35, scale: 0.08, seed: 3 })
})

export const chickenSurface = () => surface(256, (ctx, size) => {
  const random = rng(9)
  ctx.fillStyle = '#e8d2ab'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(190, 150, 100, 0.35)'
  for (let i = 0; i < 160; i++) {
    const y = random() * size
    ctx.lineWidth = 0.6 + random() * 1.4
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.bezierCurveTo(size * 0.3, y + (random() - 0.5) * 12, size * 0.6, y + (random() - 0.5) * 12, size, y + (random() - 0.5) * 8)
    ctx.stroke()
  }
  for (let i = 0; i < 14; i++) {
    const x = random() * size
    const y = random() * size
    ctx.fillStyle = radial(ctx, x, y, 0, 18 + random() * 30, [[0, 'rgba(176, 112, 50, 0.7)'], [1, 'rgba(176, 112, 50, 0)']])
    ctx.fillRect(0, 0, size, size)
  }
  grain(ctx, { amount: 0.2, scale: 0.06, seed: 7 })
})

export const ndujaSurface = () => surface(256, (ctx, size) => {
  ctx.fillStyle = '#b3341b'
  ctx.fillRect(0, 0, size, size)
  speckle(ctx, size, 700, ['#8d2412', '#d0542a', '#6e1a0c', '#e2793e'], [0.5, 2.5], rng(15))
  grain(ctx, { amount: 0.3, scale: 0.05, seed: 11 })
})

export const cornSurface = () => surface(64, (ctx, size) => {
  ctx.fillStyle = radial(ctx, size * 0.4, size * 0.35, 2, size * 0.7, [[0, '#ffe58a'], [0.6, '#f4c12c'], [1, '#d9961a']])
  ctx.fillRect(0, 0, size, size)
})

/* ---------- The paper and the printed riso mat ---------- */

export const paperTexture = () => {
  const canvas = makeCanvas(512)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f4efe4'
  ctx.fillRect(0, 0, 512, 512)
  const random = rng(77)
  const image = ctx.getImageData(0, 0, 512, 512)
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 8
    image.data[i] += n
    image.data[i + 1] += n
    image.data[i + 2] += n
  }
  ctx.putImageData(image, 0, 0)
  for (let i = 0; i < 220; i++) {
    ctx.strokeStyle = `rgba(150, 130, 100, ${0.03 + random() * 0.05})`
    ctx.lineWidth = 0.6
    const x = random() * 512
    const y = random() * 512
    const a = random() * Math.PI
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6 + 3, x + Math.cos(a) * 14, y + Math.sin(a) * 14)
    ctx.stroke()
  }
  const texture = toTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

// A thin halftone ring printed in riso blue, with a pink pass slightly out of register.
export const risoMatTexture = () => {
  const size = 2048
  const canvas = makeCanvas(size)
  const ctx = canvas.getContext('2d')
  const c = size / 2
  const step = 16
  for (let y = step / 2; y < size; y += step) {
    for (let x = step / 2; x < size; x += step) {
      const d = Math.hypot(x - c, y - c) / c
      if (d > 0.97 || d < 0.8) continue
      const t = (d - 0.8) / 0.17
      const r = step * 0.42 * Math.sin(t * Math.PI) ** 1.2
      if (r < 0.7) continue
      ctx.fillStyle = '#2c4fa3'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.lineWidth = 5
  ctx.strokeStyle = '#ff48b0'
  ctx.beginPath()
  ctx.arc(c + 8, c + 6, c * 0.985, 0, Math.PI * 2)
  ctx.stroke()
  return toTexture(canvas)
}

// Soft contact shadow under the pizza, darkest right at the edge where it touches.
export const shadowBlobTexture = () => {
  const canvas = makeCanvas(512)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = radial(ctx, 256, 256, 0, 256, [[0, 'rgba(255,255,255,0.55)'], [0.72, 'rgba(255,255,255,0.5)'], [0.8, 'rgba(255,255,255,0.36)'], [0.9, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']])
  ctx.fillRect(0, 0, 512, 512)
  return toTexture(canvas, { srgb: false })
}

export const softDotTexture = () => {
  const canvas = makeCanvas(128)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = radial(ctx, 64, 64, 0, 64, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']])
  ctx.fillRect(0, 0, 128, 128)
  return toTexture(canvas, { srgb: false })
}
