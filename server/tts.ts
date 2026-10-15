// ElevenLabs text-to-speech (eleven_flash_v2_5, streaming endpoint). The server starts synthesis as soon as a
// sentence is ready (often before the customer's turn is confirmed over) and buffers the mp3 bytes; the kiosk fetches
// GET /api/tts/:id, which replays what's buffered and then streams the rest, so playback starts while it's still
// generating. Fixed lines (greeting, "scan that to pay", paid) are synthesised once at startup and served from memory.
import { randomUUID } from "node:crypto";
import type { Response } from "express";

/** George (premade): British, middle-aged, "warm, captivating storyteller". Override with ELEVENLABS_VOICE_ID. */
export const voiceId = () => process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const MODEL = "eleven_flash_v2_5";
const FORMAT = "mp3_22050_32"; // smallest/fastest mp3; fine for speech

export const hasTts = () => !!process.env.ELEVENLABS_API_KEY;

interface Clip {
  text: string;
  chunks: Buffer[];
  done: boolean;
  failed: boolean;
  listeners: Set<() => void>;
  abort: AbortController;
  /** Called once with ms from start to first audio byte. */
  onFirstByte?: (ms: number) => void;
}

const clips = new Map<string, Clip>(); // id -> clip
const cache = new Map<string, Buffer>(); // text -> full mp3, for fixed lines

function notify(c: Clip) { for (const l of c.listeners) l(); }

async function synth(c: Clip) {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId()}/stream?output_format=${FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ text: c.text, model_id: MODEL }),
      signal: c.abort.signal,
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => "")}`);
    let first = true;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      if (first) { first = false; c.onFirstByte?.(Date.now() - t0); }
      c.chunks.push(Buffer.from(chunk));
      notify(c);
    }
  } catch (e) {
    if (!c.abort.signal.aborted) console.error(`[tts] "${c.text}": ${(e as Error).message}`);
    c.failed = true;
  }
  c.done = true;
  notify(c);
}

/** Start synthesising `text` now; returns the clip id (play it via /api/tts/:id). */
export function startTts(text: string, onFirstByte?: (ms: number) => void): string {
  const id = randomUUID();
  const cached = cache.get(text);
  const c: Clip = { text, chunks: cached ? [cached] : [], done: !!cached, failed: false, listeners: new Set(), abort: new AbortController(), onFirstByte };
  clips.set(id, c);
  setTimeout(() => clips.delete(id), 120_000);
  if (cached) onFirstByte?.(0);
  else if (hasTts()) void synth(c);
  else { c.done = c.failed = true; }
  return id;
}

/** Abort an in-flight synthesis (speculative reply cancelled). */
export function cancelTts(id: string) {
  const c = clips.get(id);
  if (!c) return;
  c.abort.abort();
  clips.delete(id);
}

export const ttsPath = (id: string) => `/api/tts/${id}`;

/** GET /api/tts/:id — buffered bytes first, then live chunks until synthesis ends. */
export function streamTts(id: string, res: Response) {
  const c = clips.get(id);
  if (!c) { res.status(404).send("unknown or expired tts id"); return; }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  let sent = 0;
  const pump = () => {
    while (sent < c.chunks.length) res.write(c.chunks[sent++]);
    if (c.done) { c.listeners.delete(pump); res.end(); }
  };
  c.listeners.add(pump);
  res.on("close", () => c.listeners.delete(pump));
  pump();
}

/** Synthesise fixed lines once at startup so they play instantly. Also warms the HTTPS connection. */
export async function precache(lines: string[]) {
  if (!hasTts()) return console.warn("[warn] ELEVENLABS_API_KEY not set: kiosk will show replies but not speak");
  const t0 = Date.now();
  await Promise.all(lines.map(async (text) => {
    const c: Clip = { text, chunks: [], done: false, failed: false, listeners: new Set(), abort: new AbortController() };
    await synth(c);
    if (!c.failed) cache.set(text, Buffer.concat(c.chunks));
  }));
  console.log(`[tts] pre-cached ${cache.size}/${lines.length} fixed lines in ${Date.now() - t0}ms (voice ${voiceId()})`);
}
