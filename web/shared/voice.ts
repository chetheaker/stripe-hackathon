// Kiosk voice I/O, hands-free (the mic stays open):
//  - Mic capture via an AudioWorklet -> 16 kHz mono linear16 PCM -> server (Deepgram Flux), in 80ms chunks.
//  - Noise gate: calibrates the room for ~1.5s at Start, then only passes audio that's clearly above ambient
//    (ambient × GATE, with a floor), ~150ms attack, ~600ms hang, with a short pre-roll so word onsets aren't cut.
//    Below the gate we send silence (keeps the stream alive) instead of room noise.
//  - Playback: a queue of <audio> elements pointing at the server's streaming TTS URLs (starts while still streaming).
//  - Echo / barge-in: by default the mic is gated while the kiosk speaks (+300ms). ?bargein=1 allows interrupting,
//    but only after ~400ms of above-gate speech.
// URL params: ?gate=3 (gate multiplier over ambient), ?bargein=1.
// Shared by the plain kiosk (web/basic/main.ts, which uses the built-in DOM "kiosk says" line + meter) and the
// React order screen's live mode (web/src/feed.js, which passes {dom:false} and renders via onState instead).

const params = new URLSearchParams(location.search);
export const bargeIn = params.get("bargein") === "1";
const GATE = Number(params.get("gate")) || 3;
const GATE_FLOOR = 0.008; // RMS floor (float samples, 0..1)
const FRAME_MS = 20;
const ATTACK_MS = 150;
const HANG_MS = 600;
const PREROLL_MS = 300;
const ECHO_TAIL_MS = 300;
const BARGE_MS = 400;
const CALIBRATE_MS = 1500;

let sendJson: (msg: object) => void = () => {};
let sendBin: (buf: ArrayBuffer) => void = () => {};
let saysEl: HTMLElement | null = null;
let meterEl: HTMLElement | null = null;
let meterBar: HTMLElement | null = null;
let meterDot: HTMLElement | null = null;

/** Mic/kiosk state for UIs that draw their own indicator: calibrating (keep quiet), open (hearing speech),
 *  speaking (kiosk talking), idle (below the gate), off (mic stopped). */
export type VoiceState = "off" | "calibrating" | "idle" | "open" | "speaking";
let onState: (s: VoiceState) => void = () => {};
let lastState: VoiceState = "off";
function emitState(s: VoiceState) {
  if (s === lastState) return;
  lastState = s;
  onState(s);
}

// ---- playback queue ------------------------------------------------------------------------
interface Clip { id: string; el: HTMLAudioElement }
const queue: Clip[] = [];
let current: Clip | null = null;
let speaking = false;
let speakingEndedAt = 0;
let lastTurn: number | null = null;

function setSpeaking(on: boolean) {
  if (speaking === on) return;
  speaking = on;
  if (!on) speakingEndedAt = performance.now();
  sendJson({ type: "speaking", on });
  if (stream) emitState(on ? "speaking" : "idle");
}

function playNext() {
  current = queue.shift() ?? null;
  if (!current) return setSpeaking(false);
  setSpeaking(true);
  const clip = current;
  clip.el.onended = clip.el.onerror = () => { if (current === clip) playNext(); };
  clip.el.addEventListener("playing", () => sendJson({ type: "playback", id: clip.id }), { once: true });
  clip.el.play().catch((e) => {
    console.warn("[voice] play failed (tap Start first to unlock audio)", e);
    if (current === clip) playNext();
  });
}

/** {type:"say"} from the server: show the text and queue the audio (fetching starts now). */
export function say(msg: { text: string; audio_url: string; id?: string; turn?: number | null }) {
  if (saysEl) {
    const same = msg.turn != null && msg.turn === lastTurn;
    saysEl.textContent = same ? `${saysEl.textContent} ${msg.text}` : `🍕 ${msg.text}`;
  }
  lastTurn = msg.turn ?? null;
  const el = new Audio(msg.audio_url);
  el.preload = "auto";
  queue.push({ id: msg.id ?? msg.audio_url, el });
  if (!current) playNext();
}

export function stopSpeaking() {
  queue.splice(0).forEach((c) => c.el.removeAttribute("src"));
  if (current) { current.el.pause(); current.el.removeAttribute("src"); current.el.load(); }
  current = null;
  setSpeaking(false);
}

// ---- UI hooks ----------------------------------------------------------------------------------
/** Call once with the WS senders. Adds the "kiosk says" line and a small mic level meter
 *  (unless opts.dom === false; then use opts.onState to draw your own indicator). */
export function initVoice(
  send: (msg: object) => void,
  sendBinary: (buf: ArrayBuffer) => void,
  opts: { dom?: boolean; onState?: (s: VoiceState) => void } = {},
) {
  sendJson = send;
  sendBin = sendBinary;
  onState = opts.onState ?? (() => {});
  if (opts.dom === false) return;
  saysEl = document.createElement("div");
  saysEl.id = "kiosk-says";
  saysEl.className = "kiosk-says";
  saysEl.style.cssText = "margin:0 0 12px;padding:10px 14px;border-radius:10px;background:rgba(255,200,80,.15);font-size:1.1em;min-height:1.4em";
  (document.querySelector(".transcript-panel") ?? document.body).prepend(saysEl);

  meterEl = document.createElement("span");
  meterEl.id = "mic-meter";
  meterEl.title = `noise gate ×${GATE}${bargeIn ? ", barge-in on" : ""}`;
  meterEl.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:10px;vertical-align:middle";
  meterEl.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:#888;display:inline-block"></span>` +
    `<span style="width:70px;height:6px;background:rgba(127,127,127,.3);border-radius:3px;overflow:hidden;display:inline-block;position:relative">` +
    `<span style="position:absolute;left:0;top:0;bottom:0;width:0;background:#4c4"></span>` +
    `<span style="position:absolute;left:33%;top:0;bottom:0;width:1px;background:#fff"></span></span>`;
  meterDot = meterEl.children[0] as HTMLElement;
  meterBar = meterEl.children[1].children[0] as HTMLElement;
  meterEl.style.visibility = "hidden";
  (document.querySelector(".status") ?? document.body).append(meterEl);
}

/** Browsers block audio until a user gesture: call from the Start button's click handler. */
export function unlockAudio() {
  const wav = new Uint8Array(46);
  const v = new DataView(wav.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 38, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, 2, true);
  new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))).play().catch(() => {});
}

// ---- mic capture + noise gate --------------------------------------------------------------
// Worklet: downsample to 16 kHz (box filter) and post 20ms Float32 frames.
const WORKLET = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = 0; this.n = 0; this.pos = 0; this.out = new Float32Array(320); this.i = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.i++] = this.acc / this.n; this.acc = 0; this.n = 0;
        if (this.i === 320) { this.port.postMessage(this.out.slice(0)); this.i = 0; }
      }
    }
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);`;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;

export const micOn = () => !!stream;

export async function startMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "pcm16k");
  src.connect(node);
  resetGate();
  node.port.onmessage = (e) => onFrame(e.data as Float32Array);
  if (meterEl) meterEl.style.visibility = "visible";
  emitState("calibrating");
}

export function stopMic() {
  node?.disconnect();
  stream?.getTracks().forEach((t) => t.stop());
  void ctx?.close();
  node = null; stream = null; ctx = null;
  if (meterEl) meterEl.style.visibility = "hidden";
  emitState("off");
}

// Gate state
let startedAt = 0;
let calib: number[] = [];
let ambient = 0;
let open = false;
let aboveMs = 0;
let belowMs = 0;
let preroll: Int16Array[] = [];
let outBuf: Int16Array[] = [];
const SILENCE = new Int16Array(320);

function resetGate() {
  startedAt = performance.now();
  calib = []; ambient = 0; open = false; aboveMs = 0; belowMs = 0; preroll = []; outBuf = [];
}

function toInt16(f: Float32Array) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return o;
}

function emit(frame: Int16Array) {
  outBuf.push(frame);
  if (outBuf.length < 4) return; // 80ms chunks
  const all = new Int16Array(outBuf.length * 320);
  outBuf.forEach((f, i) => all.set(f, i * 320));
  outBuf = [];
  sendBin(all.buffer);
}

function onFrame(f: Float32Array) {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  const pcm = toInt16(f);
  const now = performance.now();

  // 1. Calibrate ambient level.
  if (now - startedAt < CALIBRATE_MS) {
    calib.push(rms);
    const sorted = [...calib].sort((a, b) => a - b);
    ambient = sorted[Math.floor(sorted.length / 2)]; // median
    meter(rms, Math.max(ambient * GATE, GATE_FLOOR), false, true);
    return emit(SILENCE);
  }
  const threshold = Math.max(ambient * GATE, GATE_FLOOR);
  const above = rms > threshold;
  preroll.push(pcm);
  if (preroll.length > PREROLL_MS / FRAME_MS + BARGE_MS / FRAME_MS) preroll.shift();

  // 2. Kiosk talking: either fully deaf (default) or barge-in after BARGE_MS of speech.
  const echoWindow = speaking || now - speakingEndedAt < ECHO_TAIL_MS;
  if (echoWindow && !open) {
    if (!bargeIn) { aboveMs = 0; meter(rms, threshold, false); return emit(SILENCE); }
    aboveMs = above ? aboveMs + FRAME_MS : 0;
    if (aboveMs < BARGE_MS) { meter(rms, threshold, false); return emit(SILENCE); }
    stopSpeaking();
    sendJson({ type: "barge_in" });
    open = true; belowMs = 0;
    for (const p of preroll.splice(0)) emit(p);
    meter(rms, threshold, true);
    return;
  }

  // 3. Normal gate with attack / hang.
  if (!open) {
    aboveMs = above ? aboveMs + FRAME_MS : 0;
    if (!above) ambient = ambient * 0.995 + rms * 0.005; // track slow changes in room noise
    if (aboveMs >= ATTACK_MS) {
      open = true; belowMs = 0;
      const keep = Math.ceil((PREROLL_MS + ATTACK_MS) / FRAME_MS);
      for (const p of preroll.slice(-keep)) emit(p); // includes this frame
      preroll = [];
      meter(rms, threshold, true);
      return;
    }
    meter(rms, threshold, false);
    return emit(SILENCE);
  }
  belowMs = above ? 0 : belowMs + FRAME_MS;
  if (belowMs >= HANG_MS) { open = false; aboveMs = 0; }
  meter(rms, threshold, open);
  emit(pcm);
}

let meterTick = 0;
function meter(rms: number, threshold: number, isOpen: boolean, calibrating = false) {
  emitState(calibrating ? "calibrating" : isOpen ? "open" : speaking ? "speaking" : "idle");
  if (!meterBar || !meterDot || ++meterTick % 3) return; // ~16 fps
  // Scale so the threshold sits at the white tick (33%).
  meterBar.style.width = `${Math.min(100, (rms / threshold) * 33)}%`;
  meterBar.style.background = isOpen ? "#4c4" : "#999";
  meterDot.style.background = calibrating ? "#fa0" : isOpen ? "#2d2" : speaking ? "#48f" : "#888";
  meterDot.title = calibrating ? "calibrating room noise…" : isOpen ? "listening (speech)" : speaking ? "kiosk speaking" : "below gate";
}
