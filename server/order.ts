// Per-kiosk-connection order session: transcript, cart, status, agent serialisation, checkout + payment.
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { reconcile, type AgentResult } from "./agent.js";
import { MENU_BY_ID, MENU_CURRENCY, resolveVariant } from "./menu.js";
import { createCheckout, isCheckoutPaid } from "./stripe.js";
import { ttsUrl } from "./tts.js";

export type Status = "ordering" | "awaiting_confirmation" | "awaiting_payment" | "paid";
export interface CartLine {
  menu_id: string; name: string; qty: number; unit_price_cents: number; line_total_cents: number; quote: string;
  /** Variant size key and human label; size_label is null for single-size items. */
  size: string; size_label: string | null; price_id: string;
  /** True when the customer didn't say a size and the default was applied (multi-size items only). */
  defaulted: boolean;
}

/** order_id -> session, so the webhook can find the right kiosk. */
const byOrder = new Map<string, OrderSession>();
export const findByOrderId = (orderId: string) => byOrder.get(orderId);

export class OrderSession {
  orderId = randomUUID();
  transcript: string[] = [];
  cart: CartLine[] = [];
  status: Status = "ordering";
  /** Customer + kiosk lines, for the agent's conversational context. */
  private dialogue: string[] = [];
  /** Latest agent result and the transcript length it covers. */
  private last: { r: AgentResult; n: number } | null = null;
  /** End of the customer's turn reached; a reply is owed once the agent has caught up. */
  private replyOwed = false;
  /** Transcript length we last replied to (stops speech_final + UtteranceEnd double replies). */
  private repliedAt = -1;
  private upsellMade = false;
  private hasSpoken = false;
  /** Cart signature at read-back time; any change means "back to ordering". */
  private readBackSig = "";
  /** Kiosk is (or is about to be) playing audio. */
  speaking = false;
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

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.send({ type: "status", status: s });
  }
  private get talking() { return this.status === "ordering" || this.status === "awaiting_confirmation"; }

  /** Speak a line through the kiosk (Deepgram TTS) and remember it in the dialogue. */
  say(text: string) {
    this.hasSpoken = true;
    this.dialogue.push(`Kiosk: ${text}`);
    this.speaking = true; // until the kiosk reports otherwise
    this.send({ type: "say", text, audio_url: ttsUrl(text) });
  }

  /** Customer started talking again: drop any reply we were about to give. */
  interrupt() {
    this.replyOwed = false;
  }

  /** A final transcript chunk (from Deepgram or typed). */
  addFinal(text: string) {
    text = text.trim();
    if (!text) return;
    if (!this.talking) return this.notice("Order already sent to payment — tap Reset to start over.");
    this.transcript.push(text);
    this.dialogue.push(`Customer: ${text}`);
    this.runAgent();
  }

  /** End of the customer's turn (Deepgram speech_final / UtteranceEnd, or a typed message). */
  endOfTurn() {
    if (!this.talking || !this.transcript.length) return;
    this.replyOwed = true;
    this.maybeRespond();
  }

  /** Respond once the agent result covers everything the customer has said this turn. */
  private maybeRespond() {
    if (!this.replyOwed || this.agentBusy || !this.last || this.last.n !== this.transcript.length) return;
    if (this.repliedAt === this.transcript.length) { this.replyOwed = false; return; }
    this.replyOwed = false;
    this.repliedAt = this.transcript.length;
    void this.respond(this.last.r);
  }

  private cartSig() { return this.cart.map((l) => `${l.menu_id}|${l.size}|${l.qty}`).sort().join(","); }

  private async respond(r: AgentResult) {
    if (this.status === "awaiting_confirmation") {
      if (r.confirm === "yes" && this.cartSig() === this.readBackSig) return this.checkout();
      if (r.confirm === "no" || this.cartSig() !== this.readBackSig) {
        this.setStatus("ordering");
        return this.say(r.reply || "No problem. What would you like to change?");
      }
      return this.say(r.reply ? `${r.reply} Shall I bring up the payment code?` : "Shall I bring up the payment code?");
    }
    if (r.order_complete) return this.readBack();
    if (r.reply) {
      if (r.upsell_offered) this.upsellMade = true;
      this.say(r.reply);
    }
  }

  /** Deterministic read-back, built by the server from the priced cart. */
  readBack() {
    if (this.status !== "ordering") return;
    if (!this.cart.length) return this.say("Your basket's empty. What can I get you?");
    const total = this.cart.reduce((s, l) => s + l.line_total_cents, 0);
    const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: MENU_CURRENCY.toUpperCase() }).format(total / 100);
    this.readBackSig = this.cartSig();
    this.setStatus("awaiting_confirmation");
    this.say(`So that's ${listJoin(this.cart.map(spokenLine))}. That comes to ${money}. Shall I bring up the payment code?`);
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
          const n = this.transcript.length;
          result = await reconcile([...this.transcript], {
            dialogue: [...this.dialogue],
            status: this.status === "awaiting_confirmation" ? "awaiting_confirmation" : "ordering",
            upsellAvailable: !this.upsellMade,
            firstReply: !this.hasSpoken,
          });
          if (gen === this.generation) this.last = { r: result, n };
        } catch (e) {
          this.error(`Cart agent failed: ${(e as Error).message}`);
          break;
        }
        if (gen !== this.generation || !this.talking) return;
        this.apply(result);
      } while (this.agentDirty && gen === this.generation && this.talking);
    } finally {
      if (gen === this.generation) this.agentBusy = false;
    }
    if (gen === this.generation) this.maybeRespond();
  }

  /** Live cart update on every final chunk; speaking waits for end of turn (respond). */
  private apply(r: AgentResult) {
    this.cart = r.items.map((it) => {
      const m = MENU_BY_ID.get(it.menu_id)!;
      const v = resolveVariant(m, it.size)!; // validate() guarantees a real variant
      return {
        menu_id: m.id, name: m.name, qty: it.qty, unit_price_cents: v.price_cents, line_total_cents: v.price_cents * it.qty,
        quote: it.quote, size: v.size, size_label: m.variants.length > 1 ? v.label : null, price_id: v.price_id,
        defaulted: it.defaulted,
      };
    });
    this.pushCart();
    for (const n of r.notices) this.notice(n);
    for (const u of r.unrecognised) this.notice(`Sorry, we don't have "${u.text}" — ${u.reason}`);
    for (const n of r.needs_confirmation) this.notice(n.question);
  }

  pushCart() {
    const total_cents = this.cart.reduce((s, l) => s + l.line_total_cents, 0);
    this.send({ type: "cart", items: this.cart, total_cents, currency: MENU_CURRENCY });
  }

  /** Kiosk "Done" button: read-back first; a second press while awaiting confirmation goes straight to checkout. */
  done() {
    if (this.status === "awaiting_confirmation") return void this.checkout();
    this.readBack();
  }

  /** Create the Checkout Session (after a "yes", or {type:"checkout_now"} for testing). */
  async checkout() {
    if (!this.talking) return;
    if (!this.cart.length) return this.notice("Your cart is empty — tell me what you'd like first!");
    this.setStatus("awaiting_payment");
    const gen = this.generation;
    try {
      const cs = await createCheckout(this.orderId, this.cart);
      if (gen !== this.generation) return;
      this.checkoutId = cs.id;
      this.send({ type: "checkout", url: cs.url });
      this.say("Lovely, scan that to pay.");
      this.startPoller();
    } catch (e) {
      if (gen === this.generation) this.setStatus("ordering");
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
    this.setStatus("paid");
    this.stopPoller();
    console.log(`[order] ${this.orderId} paid (via ${source})`);
    this.send({ type: "paid" });
    this.say("And there it is. Transaction complete. Remarkable. Enjoy your pizza.");
  }

  reset() {
    this.generation++;
    this.stopPoller();
    byOrder.delete(this.orderId);
    this.orderId = randomUUID();
    byOrder.set(this.orderId, this);
    this.transcript = [];
    this.cart = [];
    this.setStatus("ordering");
    this.dialogue = [];
    this.last = null;
    this.replyOwed = false;
    this.repliedAt = -1;
    this.upsellMade = false;
    this.hasSpoken = false;
    this.readBackSig = "";
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

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const plural = (name: string, n: number) => (n === 1 || /s$/i.test(name) ? name : `${name}s`);

/** "two medium Pepperonis", "a can of Diet Coke", "a Garlic bread". */
function spokenLine(l: CartLine): string {
  const n = l.qty === 1 ? "a" : NUMBER_WORDS[l.qty] ?? String(l.qty);
  if (l.size === "can" || l.size === "bottle") return `${n} ${plural(l.size, l.qty)} of ${l.name}`;
  if (l.size === "six" || l.size === "twelve") return `${n} ${l.size === "six" ? "six" : "twelve"}-piece ${plural(l.name, l.qty)}`;
  const size = l.size_label && ["small", "medium", "large"].includes(l.size) ? `${l.size} ` : "";
  const rest = `${size}${plural(l.name, l.qty)}`;
  return `${n === "a" && /^[aeiou]/i.test(rest) ? "an" : n} ${rest}`;
}
function listJoin(xs: string[]) {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
