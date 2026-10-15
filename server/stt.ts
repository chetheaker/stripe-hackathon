// Deepgram Flux live STT (flux-general-en, /v2/listen) over a raw WebSocket. Flux is built for voice agents: it does
// turn detection itself and emits TurnInfo events (StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn).
// The browser sends 16 kHz mono linear16 PCM (gated: silence below the noise gate), so the stream is continuous.
import WebSocket from "ws";
import { KEYTERMS } from "./menu.js";

export interface Word { word: string; confidence: number }
export interface SttEvents {
  /** Live (interim) transcript of the current turn. */
  update(text: string): void;
  /** Flux thinks the turn is probably over: start speculative work. */
  eagerEnd(text: string, words: Word[]): void;
  /** The customer carried on after an EagerEndOfTurn: cancel speculative work. */
  resumed(): void;
  /** The turn is over. */
  end(text: string, words: Word[]): void;
  error(msg: string): void;
}

export function hasDeepgram() {
  return !!process.env.DEEPGRAM_API_KEY;
}

export class Stt {
  private dg: WebSocket | null = null;
  private pending: Buffer[] = [];
  private idle: NodeJS.Timeout | undefined;

  constructor(private ev: SttEvents) {}

  /** Forward one chunk of 16 kHz linear16 PCM. Opens the Deepgram stream lazily. */
  push(chunk: Buffer) {
    if (!hasDeepgram()) return;
    if (!this.dg) this.open();
    if (this.dg!.readyState === WebSocket.OPEN) this.dg!.send(chunk);
    else if (this.pending.length < 200) this.pending.push(chunk);
    // Mic stopped (no audio for a while): close so we don't hold a Flux stream open.
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 10_000);
  }

  private open() {
    const params = new URLSearchParams({
      model: "flux-general-en",
      encoding: "linear16",
      sample_rate: "16000",
      eot_threshold: process.env.FLUX_EOT_THRESHOLD || "0.7",
      eager_eot_threshold: process.env.FLUX_EAGER_EOT_THRESHOLD || "0.5",
      eot_timeout_ms: "3000",
    });
    for (const k of KEYTERMS.slice(0, 100)) params.append("keyterm", k); // Flux limit: 100 keyterms
    const dg = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });
    this.dg = dg;
    dg.on("open", () => {
      for (const c of this.pending) dg.send(c);
      this.pending = [];
    });
    dg.on("message", (data) => {
      let msg: { type?: string; event?: string; transcript?: string; words?: Word[]; description?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "Error") return this.ev.error(`Deepgram: ${msg.description ?? "error"}`);
      if (msg.type !== "TurnInfo") return;
      const text = (msg.transcript ?? "").trim();
      const words = msg.words ?? [];
      switch (msg.event) {
        case "Update": case "StartOfTurn": if (text) this.ev.update(text); break;
        case "EagerEndOfTurn": this.ev.eagerEnd(text, words); break;
        case "TurnResumed": this.ev.resumed(); break;
        case "EndOfTurn": this.ev.end(text, words); break;
      }
    });
    dg.on("unexpected-response", (_req, res) => this.ev.error(`Deepgram rejected connection (HTTP ${res.statusCode})`));
    dg.on("error", (e) => this.ev.error(`Deepgram error: ${e.message}`));
    dg.on("close", () => { if (this.dg === dg) this.dg = null; });
  }

  close() {
    clearTimeout(this.idle);
    const dg = this.dg;
    this.dg = null;
    this.pending = [];
    if (dg?.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
    else dg?.terminate();
  }
}
