// Tiny synthesised sounds, so there are no audio files to load. Quiet by design.
let context = null

const audio = () => {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') context.resume()
    return context
  } catch {
    return null
  }
}

const tone = ({ from, to, duration, type = 'sine', gain = 0.08, delay = 0 }) => {
  const ctx = audio()
  if (!ctx) return
  const start = ctx.currentTime + delay
  const oscillator = ctx.createOscillator()
  const volume = ctx.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(from, start)
  oscillator.frequency.exponentialRampToValueAtTime(to, start + duration)
  volume.gain.setValueAtTime(0.0001, start)
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.01)
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(volume).connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
}

const noise = ({ duration, gain = 0.05, from = 800, to = 3000, delay = 0 }) => {
  const ctx = audio()
  if (!ctx) return
  const start = ctx.currentTime + delay
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(from, start)
  filter.frequency.exponentialRampToValueAtTime(to, start + duration)
  const volume = ctx.createGain()
  volume.gain.setValueAtTime(0.0001, start)
  volume.gain.exponentialRampToValueAtTime(gain, start + duration * 0.3)
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  source.connect(filter).connect(volume).connect(ctx.destination)
  source.start(start)
}

const muted = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const sound = {
  whoosh: () => !muted() && noise({ duration: 0.45, gain: 0.04, from: 500, to: 2600 }),
  plop: () => {
    if (muted()) return
    for (let i = 0; i < 3; i++) tone({ from: 520 - i * 60, to: 160, duration: 0.11, gain: 0.05, delay: i * 0.07 })
  },
  pop: () => !muted() && noise({ duration: 0.35, gain: 0.04, from: 2600, to: 600 }),
  slap: () => {
    if (muted()) return
    noise({ duration: 0.18, gain: 0.09, from: 1800, to: 300 })
    tone({ from: 140, to: 60, duration: 0.2, gain: 0.08 })
  },
  oven: () => !muted() && noise({ duration: 1.6, gain: 0.03, from: 200, to: 900 }),
  ding: () => {
    if (muted()) return
    tone({ from: 1568, to: 1560, duration: 1.1, type: 'triangle', gain: 0.07 })
    tone({ from: 2093, to: 2090, duration: 0.9, type: 'sine', gain: 0.04, delay: 0.12 })
  },
}
