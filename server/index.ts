import "dotenv/config";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { MENU } from "./menu.js";
import { FIXED_LINES, OrderSession, findByOrderId } from "./order.js";
import { Stt, hasDeepgram } from "./stt.js";
import { verifyWebhook } from "./stripe.js";
import { hasTts, precache, streamTts } from "./tts.js";

const PORT = Number(process.env.PORT || 3000);

for (const [k, why] of [
  ["DEEPGRAM_API_KEY", "voice input disabled — typed orders still work"],
  ["ELEVENLABS_API_KEY", "kiosk won't speak (replies still shown as text)"],
  ["ANTHROPIC_API_KEY", "cart agent will error until set"],
  ["STRIPE_SECRET_KEY", "checkout will error until set"],
  ["STRIPE_WEBHOOK_SECRET", "webhook disabled — falling back to polling Checkout"],
] as const) {
  if (!process.env[k]) console.warn(`[warn] ${k} not set: ${why}`);
}

const app = express();

// Stripe webhook needs the raw body for signature verification — register before any JSON parser.
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body as Buffer, req.header("stripe-signature"));
  } catch (e) {
    console.warn("[webhook]", (e as Error).message);
    res.status(400).send(`Webhook error: ${(e as Error).message}`);
    return;
  }
  if (event.type === "checkout.session.completed") {
    const cs = event.data.object;
    const orderId = cs.metadata?.order_id ?? cs.client_reference_id;
    if (cs.payment_status === "paid" && orderId) findByOrderId(orderId)?.markPaid("webhook");
  }
  res.json({ received: true });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, deepgram: hasDeepgram(), elevenlabs: hasTts(), anthropic: !!process.env.ANTHROPIC_API_KEY, stripe: !!process.env.STRIPE_SECRET_KEY });
});
app.get("/api/menu", (_req, res) => {
  res.json(MENU);
});
app.get("/api/tts/:id", (req, res) => streamTts(req.params.id, res));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  // Barge-in (customer can talk over the kiosk) is OFF by default: the kiosk gates its mic while speaking (+300ms),
  // because false barge-ins from room noise are worse than not being able to interrupt. ?bargein=1 turns it on
  // (the kiosk then needs ~400ms of above-gate speech before it stops playback and sends {type:"barge_in"}).
  const bargeIn = new URL(req.url ?? "/", "http://x").searchParams.get("bargein") === "1";
  console.log(`[ws] kiosk connected (barge-in ${bargeIn ? "on" : "off"})`);
  const session = new OrderSession(ws);
  const stt = new Stt({
    update: (text) => session.liveUpdate(text),
    eagerEnd: (text, words) => session.eagerEnd(text, words),
    resumed: () => session.resumed(),
    end: (text, words) => session.endTurn(text, words),
    error: (msg) => session.error(msg),
  });
  session.pushCart();
  if (!hasDeepgram()) session.notice("Voice input is off (no DEEPGRAM_API_KEY) — type your order below.");

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!hasDeepgram()) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      return stt.push(buf); // 16 kHz mono linear16 from web/voice.ts
    }
    let msg: { type?: string; text?: string; on?: boolean; id?: string; pizzas?: { size?: string; extras?: string[]; toppings?: unknown[]; qty?: number }[] };
    try { msg = JSON.parse(data.toString()); } catch { return session.error("Bad message"); }
    switch (msg.type) {
      case "text": // typed fallback: a whole customer turn (end of turn immediately)
        if (msg.text?.trim()) session.endTurn(msg.text.trim(), []);
        break;
      case "hello": session.hello(); break; // Start pressed: opening greeting (pre-cached)
      case "speaking": session.speaking = !!msg.on; break;
      case "build": session.building = !!msg.on; break; // kiosk opened/closed build your own
      case "custom": session.setCustom(msg.pizzas ?? []); break; // finished build-your-own pizzas (priced server-side)
      case "playback": if (msg.id) session.playbackStarted(msg.id); break; // kiosk audio actually started (timing log)
      case "barge_in": session.bargeIn(); break;
      case "done": session.done(); break; // read-back first; pressing again while awaiting confirmation = checkout
      case "checkout_now": void session.checkout(); break; // testing shortcut: skip the read-back
      case "reset": stt.close(); session.reset(); break;
      default: session.error(`Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    console.log("[ws] kiosk disconnected");
    stt.close();
    session.dispose();
  });
});

void precache(FIXED_LINES);
server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  (ws: /ws, webhook: POST /webhook)`));
