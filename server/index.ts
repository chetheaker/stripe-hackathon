import "dotenv/config";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { MENU } from "./menu.js";
import { OrderSession, findByOrderId } from "./order.js";
import { Stt, hasDeepgram } from "./stt.js";
import { verifyWebhook } from "./stripe.js";

const PORT = Number(process.env.PORT || 3000);

for (const [k, why] of [
  ["DEEPGRAM_API_KEY", "voice input disabled — typed orders still work"],
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
  res.json({ ok: true, deepgram: hasDeepgram(), anthropic: !!process.env.ANTHROPIC_API_KEY, stripe: !!process.env.STRIPE_SECRET_KEY });
});
app.get("/api/menu", (_req, res) => {
  res.json(MENU);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[ws] kiosk connected");
  const session = new OrderSession(ws);
  const stt = new Stt(
    (text, final) => {
      session.send({ type: "transcript", text, final });
      if (final) session.addFinal(text);
    },
    (msg) => session.error(msg),
  );
  session.pushCart();
  if (!hasDeepgram()) session.notice("Voice input is off (no DEEPGRAM_API_KEY) — type your order below.");

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!hasDeepgram()) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      return stt.push(buf);
    }
    let msg: { type?: string; text?: string };
    try { msg = JSON.parse(data.toString()); } catch { return session.error("Bad message"); }
    switch (msg.type) {
      case "text": // typed fallback — behaves exactly like a final transcript chunk
        if (msg.text?.trim()) {
          session.send({ type: "transcript", text: msg.text.trim(), final: true });
          session.addFinal(msg.text);
        }
        break;
      case "done": void session.checkout(); break;
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

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  (ws: /ws, webhook: POST /webhook)`));
