// Kiosk voice: plays the server's {type:"say"} audio (Deepgram TTS, streamed mp3), stops on {type:"stop_speaking"},
// and tells the server when it's speaking so it can ignore echo / handle barge-in.
//
// Barge-in (talking over the kiosk) is ON by default, for headset use. Add ?bargein=0 to the kiosk URL to turn it off:
// the mic stops sending audio while the kiosk speaks, and the server ignores transcripts meanwhile.

export const bargeIn = new URLSearchParams(location.search).get("bargein") !== "0";

const audio = new Audio();
audio.preload = "auto";
let speaking = false;
let sendFn: (msg: object) => void = () => {};
let saysEl: HTMLElement | null = null;

function setSpeaking(on: boolean) {
  if (speaking === on) return;
  speaking = on;
  sendFn({ type: "speaking", on });
}

/** True while the kiosk is talking and barge-in is off: main.ts should not send mic audio. */
export const micMuted = () => speaking && !bargeIn;

/** Call once with the WS send function. Adds a "Kiosk says" line above the transcript panel's heading. */
export function initVoice(send: (msg: object) => void) {
  sendFn = send;
  audio.onended = () => setSpeaking(false);
  audio.onerror = () => setSpeaking(false);
  saysEl = document.createElement("div");
  saysEl.id = "kiosk-says";
  saysEl.className = "kiosk-says";
  saysEl.style.cssText = "margin:0 0 12px;padding:10px 14px;border-radius:10px;background:rgba(255,200,80,.15);font-size:1.1em;min-height:1.4em";
  saysEl.textContent = "";
  const panel = document.querySelector(".transcript-panel") ?? document.body;
  panel.prepend(saysEl);
}

/** Browsers block audio until a user gesture: call from the Start button's click handler. */
export function unlockAudio() {
  // Playing a tiny silent WAV inside the gesture unlocks the element for later programmatic plays (Safari too).
  const wav = new Uint8Array(46);
  const v = new DataView(wav.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 38, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, 2, true);
  audio.src = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  audio.play().catch(() => {});
}

export function say(text: string, audioUrl: string) {
  if (saysEl) saysEl.textContent = `🍕 ${text}`;
  audio.pause();
  audio.src = audioUrl; // streamed from the server; playback starts as bytes arrive
  setSpeaking(true);
  audio.play().catch((e) => {
    console.warn("[voice] play failed (tap Start first to unlock audio)", e);
    setSpeaking(false);
  });
}

export function stopSpeaking() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  setSpeaking(false);
}
