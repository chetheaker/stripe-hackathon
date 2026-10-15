// Deepgram Aura-2 text-to-speech. The server hands the kiosk a short-lived /api/tts/:id URL; fetching it streams
// Deepgram's mp3 straight through, so playback starts before synthesis finishes.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Response } from "express";

/** British, warm, baritone (Deepgram metadata). Override with TTS_MODEL. */
export const ttsModel = () => process.env.TTS_MODEL || "aura-2-draco-en";

const pending = new Map<string, string>(); // id -> text

/** Register text to speak; returns the URL the kiosk should play. */
export function ttsUrl(text: string): string {
  const id = randomUUID();
  pending.set(id, text);
  setTimeout(() => pending.delete(id), 60_000);
  return `/api/tts/${id}`;
}

export async function streamTts(id: string, res: Response) {
  const text = pending.get(id);
  if (!text) { res.status(404).send("unknown or expired tts id"); return; }
  if (!process.env.DEEPGRAM_API_KEY) { res.status(503).send("DEEPGRAM_API_KEY not set"); return; }
  const t0 = Date.now();
  const params = new URLSearchParams({ model: ttsModel(), encoding: "mp3" });
  const dg = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!dg.ok || !dg.body) {
    const msg = await dg.text().catch(() => "");
    console.error(`[tts] Deepgram HTTP ${dg.status}: ${msg}`);
    res.status(502).send(`tts failed (${dg.status})`);
    return;
  }
  console.log(`[tts] first byte ${Date.now() - t0}ms: "${text}"`);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  Readable.fromWeb(dg.body as import("node:stream/web").ReadableStream).pipe(res);
}
