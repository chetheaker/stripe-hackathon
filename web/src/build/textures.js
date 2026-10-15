import * as THREE from 'three'

// Seeded random so the pizza looks the same every time it's built.
export const rng = (seed) => {
  let value = seed % 2147483647
  if (value <= 0) value += 2147483646
  return () => {
    value = (value * 16807) % 2147483647
    return (value - 1) / 2147483646
  }
}

const canvasTexture = (size, draw, { srgb = true } = {}) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  draw(canvas.getContext('2d'), size)
  const texture = new THREE.CanvasTexture(canvas)
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

const blob = (ctx, x, y, radius, color, alpha = 1) => {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, color.replace('ALPHA', alpha))
  gradient.addColorStop(1, color.replace('ALPHA', 0))
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

/*
  Dough is a lathe, so the texture's v runs along the profile: bottom (0),
  around the rim (middle), to the centre top (1). Rows are painted by v so
  the rim browns more than the middle when baked.
*/
export const DOUGH_V = { rimStart: 0.14, rimEnd: 0.83 }

const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t))
const rgb = (color) => `rgb(${color.join(',')})`

export const doughTextures = () => {
  const paint = (baked) => canvasTexture(512, (ctx, size) => {
    const random = rng(baked ? 11 : 7)
    for (let y = 0; y < size; y++) {
      const v = 1 - y / size
      let color
      if (!baked) color = [232, 196, 146]
      else if (v < DOUGH_V.rimStart) color = [196, 140, 80]
      else if (v > DOUGH_V.rimEnd) color = [226, 180, 118]
      else {
        const rim = Math.sin(((v - DOUGH_V.rimStart) / (DOUGH_V.rimEnd - DOUGH_V.rimStart)) * Math.PI)
        color = mix([214, 160, 92], [176, 104, 42], rim)
      }
      ctx.fillStyle = rgb(color)
      ctx.fillRect(0, y, size, 1)
    }
    // Pores and flour.
    for (let i = 0; i < 2600; i++) {
      const x = random() * size
      const y = random() * size
      ctx.fillStyle = random() > 0.5 ? 'rgba(255,250,236,0.35)' : 'rgba(120,80,40,0.12)'
      ctx.fillRect(x, y, 1 + random() * 2, 1 + random() * 2)
    }
    if (baked) {
      // Leopard spots on the rim.
      for (let i = 0; i < 420; i++) {
        const v = DOUGH_V.rimStart + 0.08 + random() * (DOUGH_V.rimEnd - DOUGH_V.rimStart - 0.16)
        const radius = 2 + random() * 7
        blob(ctx, random() * size, (1 - v) * size, radius, 'rgba(58,30,12,ALPHA)', 0.35 + random() * 0.5)
      }
    }
  })
  const raw = paint(false)
  const baked = paint(true)
  for (const texture of [raw, baked]) texture.wrapS = THREE.RepeatWrapping
  return { raw, baked }
}

// Sauce is tinted by material colour, so its texture is grey-scale.
export const sauceTexture = () => canvasTexture(512, (ctx, size) => {
  const random = rng(23)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 90; i++) {
    blob(ctx, random() * size, random() * size, 20 + random() * 60, random() > 0.5 ? 'rgba(170,170,170,ALPHA)' : 'rgba(255,255,255,ALPHA)', 0.35)
  }
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(60,60,60,${0.25 + random() * 0.4})`
    ctx.fillRect(random() * size, random() * size, 2 + random() * 3, 1 + random() * 2)
  }
  // Darker where it thins out at the edge.
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size / 2)
  edge.addColorStop(0, 'rgba(0,0,0,0)')
  edge.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, size, size)
})

/*
  Cheese is patchy blobs. Coverage lives in its own grey-scale texture (the
  layer "melts in" by lowering a threshold on it); colour textures are opaque
  so transparent pixels never darken the cheese.
*/
export const cheeseTextures = () => {
  const blobs = []
  const random = rng(41)
  for (let i = 0; i < 340; i++) {
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * 0.47
    blobs.push({ x: 0.5 + Math.cos(angle) * distance, y: 0.5 + Math.sin(angle) * distance, radius: (26 + random() * 46) / 1024, alpha: 0.55 + random() * 0.45, spot: random() > 0.55, dx: random() - 0.5, dy: random() - 0.5 })
  }
  const coverage = canvasTexture(1024, (ctx, size) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size, size)
    ctx.globalCompositeOperation = 'lighter'
    for (const b of blobs) blob(ctx, b.x * size, b.y * size, b.radius * size, 'rgba(255,255,255,ALPHA)', b.alpha * 0.8)
  }, { srgb: false })
  const paint = (baked) => canvasTexture(1024, (ctx, size) => {
    ctx.fillStyle = baked ? '#f2cf7c' : '#fffaf0'
    ctx.fillRect(0, 0, size, size)
    for (const b of blobs) {
      blob(ctx, b.x * size, b.y * size, b.radius * size, baked ? 'rgba(250,224,150,ALPHA)' : 'rgba(255,255,255,ALPHA)', 0.6)
      if (baked && b.spot) blob(ctx, (b.x + b.dx * b.radius) * size, (b.y + b.dy * b.radius) * size, b.radius * size * 0.32, 'rgba(176,102,36,ALPHA)', 0.6)
    }
  })
  return { raw: paint(false), baked: paint(true), coverage }
}

export const woodTexture = () => canvasTexture(1024, (ctx, size) => {
  const random = rng(5)
  ctx.fillStyle = '#b07a46'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 220; i++) {
    const y = random() * size
    const amplitude = 2 + random() * 8
    const frequency = 0.004 + random() * 0.01
    const phase = random() * 10
    ctx.strokeStyle = random() > 0.5 ? `rgba(90,52,22,${0.08 + random() * 0.18})` : `rgba(230,180,120,${0.06 + random() * 0.12})`
    ctx.lineWidth = 0.6 + random() * 2.4
    ctx.beginPath()
    for (let x = 0; x <= size; x += 8) {
      const offset = Math.sin(x * frequency + phase) * amplitude
      if (x === 0) ctx.moveTo(x, y + offset)
      else ctx.lineTo(x, y + offset)
    }
    ctx.stroke()
  }
  // Knife marks and flour.
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = 'rgba(70,40,18,0.12)'
    ctx.lineWidth = 1
    const x = random() * size
    const y = random() * size
    const angle = random() * Math.PI
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * 120, y + Math.sin(angle) * 120)
    ctx.stroke()
  }
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(255,248,232,${random() * 0.25})`
    ctx.fillRect(random() * size, random() * size, 2, 2)
  }
})

export const pepperoniTexture = () => canvasTexture(256, (ctx, size) => {
  const random = rng(77)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 70; i++) {
    blob(ctx, random() * size, random() * size, 3 + random() * 7, 'rgba(255,236,220,ALPHA)', 0.9)
  }
  for (let i = 0; i < 40; i++) {
    blob(ctx, random() * size, random() * size, 2 + random() * 4, 'rgba(120,60,50,ALPHA)', 0.5)
  }
})

export const softDotTexture = () => canvasTexture(128, (ctx, size) => {
  blob(ctx, size / 2, size / 2, size / 2, 'rgba(255,255,255,ALPHA)', 1)
}, { srgb: false })
