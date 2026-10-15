// Per-kiosk-connection order session: transcript, cart, status, agent serialisation, checkout + payment.
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { reconcile, type AgentResult } from "./agent.js";
import { MENU_BY_ID, MENU_CURRENCY } from "./menu.js";
import { createCheckout, isCheckoutPaid } from "./stripe.js";

export type Status = "ordering" | "awaiting_payment" | "paid";
export interface CartLine {
  menu_id: string; name: string; qty: number; unit_price_cents: number; line_total_cents: number; quote: string;
}

/** order_id -> session, so the webhook can find the right kiosk. */
const byOrder = new Map<string, OrderSession>();
export const findByOrderId = (orderId: string) => byOrder.get(orderId);

export class OrderSession {
  orderId = randomUUID();
  transcript: string[] = [];
  cart: CartLine[] = [];
  status: Status = "ordering";
  private checkoutId: string | null = null;
  private agentBusy = false;
  private agentDirty = false;
  private generation = 0; // bumped on reset so stale agent/checkout results are discarded
  private sentNotices = new Set<string>();
  private poller: NodeJS.Timeout | null = null;

  constructor(private ws: WebSocket) {
    byOrder.set(this.orderId, this);
  }

  send(msg: object) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  notice(text: string) {
    if (this.sentNotices.has(text)) return;
    this.sentNotices.add(text);
    this.send({ type: "notice", text });
  }
  error(text: string) {
    console.error("[order]", text);
    this.send({ type: "error", text });
  }

  /** A final transcript chunk (from Deepgram or typed). */
  addFinal(text: string) {
    text = text.trim();
    if (!text) return;
    if (this.status !== "ordering") return this.notice("Order already sent to payment — tap Reset to start over.");
    this.transcript.push(text);
    this.runAgent();
  }

  /** At most one in-flight agent call; finals arriving mid-call trigger exactly one re-run with the latest transcript. */
  private async runAgent() {
    if (this.agentBusy) { this.agentDirty = true; return; }
    this.agentBusy = true;
    const gen = this.generation;
    try {
      do {
        this.agentDirty = false;
        let result: AgentResult;
        try {
          result = await reconcile([...this.transcript]);
        } catch (e) {
          this.error(`Cart agent failed: ${(e as Error).message}`);
          break;
        }
        if (gen !== this.generation || this.status !== "ordering") return;
        await this.apply(result, !this.agentDirty);
      } while (this.agentDirty && gen === this.generation && this.status === "ordering");
    } finally {
      if (gen === this.generation) this.agentBusy = false;
    }
  }

  private async apply(r: AgentResult, latest: boolean) {
    this.cart = r.items.map((it) => {
      const m = MENU_BY_ID.get(it.menu_id)!;
      return { menu_id: m.id, name: m.name, qty: it.qty, unit_price_cents: m.price_cents, line_total_cents: m.price_cents * it.qty, quote: it.quote };
    });
    this.pushCart();
    for (const u of r.unrecognised) this.notice(`Sorry, we don't have "${u.text}" — ${u.reason}`);
    for (const n of r.needs_confirmation) this.notice(n.question);
    // Only act on "that's all" if no newer speech is waiting to be reconciled.
    if (r.order_complete && latest) await this.checkout();
  }

  pushCart() {
    const total_cents = this.cart.reduce((s, l) => s + l.line_total_cents, 0);
    this.send({ type: "cart", items: this.cart, total_cents, currency: MENU_CURRENCY });
  }

  /** Kiosk "Done" button or agent order_complete. */
  async checkout() {
    if (this.status !== "ordering") return;
    if (!this.cart.length) return this.notice("Your cart is empty — tell me what you'd like first!");
    this.status = "awaiting_payment";
    const gen = this.generation;
    try {
      const cs = await createCheckout(this.orderId, this.cart);
      if (gen !== this.generation) return;
      this.checkoutId = cs.id;
      this.send({ type: "checkout", url: cs.url });
      this.startPoller();
    } catch (e) {
      if (gen === this.generation) this.status = "ordering";
      this.error(`Checkout failed: ${(e as Error).message}`);
    }
  }

  /** Fallback in case the webhook isn't wired up: poll Checkout every 2s. */
  private startPoller() {
    this.stopPoller();
    this.poller = setInterval(async () => {
      if (this.status !== "awaiting_payment" || !this.checkoutId) return this.stopPoller();
      try {
        if (await isCheckoutPaid(this.checkoutId)) this.markPaid("poller");
      } catch (e) {
        console.warn("[poller]", (e as Error).message);
      }
    }, 2000);
  }
  private stopPoller() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** Idempotent — webhook and poller may both fire. */
  markPaid(source: string) {
    if (this.status !== "awaiting_payment") return;
    this.status = "paid";
    this.stopPoller();
    console.log(`[order] ${this.orderId} paid (via ${source})`);
    this.send({ type: "paid" });
  }

  reset() {
    this.generation++;
    this.stopPoller();
    byOrder.delete(this.orderId);
    this.orderId = randomUUID();
    byOrder.set(this.orderId, this);
    this.transcript = [];
    this.cart = [];
    this.status = "ordering";
    this.checkoutId = null;
    this.agentBusy = false;
    this.agentDirty = false;
    this.sentNotices.clear();
    this.pushCart();
  }

  dispose() {
    this.generation++;
    this.stopPoller();
    byOrder.delete(this.orderId);
  }
}
