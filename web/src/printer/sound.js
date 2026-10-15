// A thermal printer's buzz: short bursts of band-passed noise, one per motor step.
let context = null
let noise = null

const setup = () => {
  if (context) return context
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) return null
  context = new AudioContext()
  noise = context.createBuffer(1, context.sampleRate * 0.05, context.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return context
}

const burst = (frequency, duration, gain) => {
  const audio = setup()
  if (!audio || audio.state === 'suspended') {
    audio?.resume()
    return
  }
  const source = audio.createBufferSource()
  source.buffer = noise
  const filter = audio.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = frequency
  filter.Q.value = 6
  const volume = audio.createGain()
  const now = audio.currentTime
  volume.gain.setValueAtTime(gain, now)
  volume.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  source.connect(filter).connect(volume).connect(audio.destination)
  source.start(now)
  source.stop(now + duration)
}

export const printStep = () => burst(2600 + Math.random() * 500, 0.022, 0.05)
export const reverseStep = () => burst(1500 + Math.random() * 200, 0.018, 0.03)
