// Deepgram live STT over a raw WebSocket (simpler + more stable than the SDK's churny API).
// One instance per kiosk connection. Browser sends MediaRecorder webm/opus chunks; Deepgram
// auto-detects containerised audio, so no `encoding` param is sent.
import WebSocket from "ws";
import { KEYTERMS } from "./menu.js";

type OnTranscript = (text: string, final: boolean) => void;

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // start of a new webm stream

export function hasDeepgram() {
  return !!process.env.DEEPGRAM_API_KEY;
}

export class Stt {
  private dg: WebSocket | null = null;
  private pending: Buffer[] = [];
  private header: Buffer | null = null; // first chunk of the current webm stream, replayed on reconnect

  constructor(private onTranscript: OnTranscript, private onError: (msg: string) => void) {}

  /** Forward one browser audio chunk. A chunk starting with the EBML header means a new recording. */
  push(chunk: Buffer) {
    if (!hasDeepgram()) return;
    if (chunk.subarray(0, 4).equals(EBML_MAGIC)) {
      this.close();
      this.header = chunk;
    }
    if (!this.dg) {
      if (!this.header) return; // mid-stream chunk with no header — undecodable
      this.open();
      if (chunk !== this.header) this.pending.push(this.header);
    }
    if (this.dg!.readyState === WebSocket.OPEN) this.dg!.send(chunk);
    else this.pending.push(chunk);
  }

  private open() {
    const params = new URLSearchParams({
      model: "nova-3",
      interim_results: "true",
      endpointing: "300",
      smart_format: "true",
    });
    for (const k of KEYTERMS) params.append("keyterm", k);
    const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });
    this.dg = dg;
    let keepAlive: NodeJS.Timeout | undefined;
    dg.on("open", () => {
      for (const c of this.pending) dg.send(c);
      this.pending = [];
      keepAlive = setInterval(() => dg.readyState === WebSocket.OPEN && dg.send(JSON.stringify({ type: "KeepAlive" })), 5000);
    });
    dg.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "Results") return;
        const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
        if (text.trim()) this.onTranscript(text, !!msg.is_final);
      } catch { /* ignore non-JSON */ }
    });
    dg.on("unexpected-response", (_req, res) => this.onError(`Deepgram rejected connection (HTTP ${res.statusCode})`));
    dg.on("error", (e) => this.onError(`Deepgram error: ${e.message}`));
    dg.on("close", () => {
      if (this.dg === dg) this.dg = null;
      clearInterval(keepAlive);
    });
  }

  close() {
    const dg = this.dg;
    this.dg = null;
    this.pending = [];
    if (dg?.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
    else dg?.terminate();
  }
}
