// Per-kiosk-connection order session: transcript, cart, status, turn-taking, spoken replies, checkout + payment.
//
// Two Claude calls run in parallel:
//  - cart agent (agent.ts): full-cart reconcile, re-run (coalesced) on every live transcript update, so the cart is
//    mostly current by the time the customer stops talking. Owns the cart and all validation.
//  - reply agent (reply.ts): small streaming call started at Flux's EagerEndOfTurn; each finished sentence goes
//    straight to ElevenLabs. If the customer resumes (TurnResumed), the reply and its TTS are cancelled unplayed.
// Read-back, "scan that to pay" and the paid line are server-built text (no LLM).
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { outOfStock, reconcile, type AgentResult } from "./agent.js";
import { MENU, MENU_BY_ID, MENU_CURRENCY, resolveVariant } from "./menu.js";
import { streamReply } from "./reply.js";
import { createCheckout, isCheckoutPaid } from "./stripe.js";
import type { Word } from "./stt.js";
import { cancelTts, startTts, ttsPath } from "./tts.js";

export type Status = "ordering" | "awaiting_confirmation" | "awaiting_payment" | "paid";
export interface CartLine {
  menu_id: string; name: string; qty: number; unit_price_cents: number; line_total_cents: number; quote: string;
  /** Variant size key and human label; size_label is null for single-size items. */
  size: string; size_label: string | null; price_id: string;
  /** True when the customer didn't say a size and the default was applied (multi-size items only). */
  defaulted: boolean;
}

export const GREETING = "Ah. A hungry customer approaches. What can I get you?";
export const SCAN_TO_PAY = "Lovely, scan that to pay.";
// Same trigger as the kiosk's build-your-own (web/src/build/buildModel.js OPEN). Build mode runs on the kiosk.
const BUILD_OPEN = /\b(build|make|create|design|do)\b.{0,20}\b(my|your|me an?|our) own\b|\bbuild your own\b|\bcustom pizza\b|\bown pizza\b/i;
const END_RE = /\b(that'?s (all|it|everything|me)|nothing else|i'?m (done|good|all set)|that'?ll be (all|it)|no,? that'?s (all|it))\b/i;
export const PAID_LINE = "And there it is. Transaction complete. Remarkable. Enjoy your pizza.";
export const FIXED_LINES = [GREETING, SCAN_TO_PAY, PAID_LINE];
const ANYTHING_ELSE = "Lovely. Anything else for you?";
/** An offer of an extra item... */
const UPSELL_RE = /\b(fancy|tempt|with that|how about|would you like|add some|go with)\b/i;
/** ...unless it's the one suggestion after "we don't do that" / "out of stock". */
const ALTERNATIVE_RE = /\b(instead|don't do|do not do|out of stock|sorry|afraid)\b/i;

/** order_id -> session, so the webhook can find the right kiosk. */
const byOrder = new Map<string, OrderSession>();
export const findByOrderId = (orderId: string) => byOrder.get(orderId);

/** One customer turn's reply, possibly speculative (started at EagerEndOfTurn, not yet confirmed). */
interface Turn {
  id: number;
  text: string;
  abort: AbortController;
  clips: string[];
  committed: boolean;
  held: (() => void)[];
  t: { eot: number; end?: number; token?: number; ttsByte?: number; sent?: number; firstClip?: string };
}

// ---- noise filter for final transcripts ---------------------------------------------------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const FILLER = new Set("uh um umm er erm hmm hm mm mhm ah oh huh eh the a an and so like okay ok well".split(" "));
const MEANINGFUL = new Set([
  ..."yes yeah yep yup aye no nope nah please thanks cheers sure go done that's thats it all nothing else large medium small regular big can bottle cancel remove".split(" "),
  ..."one two three four five six seven eight nine ten eleven twelve".split(" "),
  ...MENU.flatMap((m) => [m.name, ...m.aliases]).flatMap((s) => norm(s).split(" ")).filter((w) => w.length > 2),
]);
/** False for room noise: filler-only, or short + low-confidence with no meaningful word. */
export function meaningful(text: string, words: Word[]): boolean {
  const toks = norm(text).split(" ").filter(Boolean);
  if (!toks.length || toks.every((t) => FILLER.has(t))) return false;
  const hasMeaning = toks.some((t) => MEANINGFUL.has(t) || /^\d+$/.test(t));
  if (hasMeaning) return true;
  if (toks.length === 1) return false;
  const conf = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 1;
  return !(toks.length <= 3 && conf < 0.6);
}

export class OrderSession {
  orderId = randomUUID();
  /** Committed customer turns. */
  transcript: string[] = [];
  /** Live (interim) text of the turn in progress, fed to the cart agent so the cart keeps up. */
  private live = "";
  cart: CartLine[] = [];
  status: Status = "ordering";
  /** Customer + kiosk lines, for conversational context. */
  private dialogue: string[] = [];
  private upsellMade = false;
  private hasSpoken = false;
  /** Cart signature at read-back time; any change means "back to ordering". */
  private readBackSig = "";
  /** Kiosk is playing audio (reported by the kiosk). */
  speaking = false;
  private checkoutId: string | null = null;
  private agentBusy = false;
  private agentDirty = false;
  /** Transcript (joined) that the current cart was computed from. */
  private cartCovers = "";
  private settledWaiters: (() => void)[] = [];
  private turn: Turn | null = null;
  private turnSeq = 0;
  private generation = 0; // bumped on reset so stale agent/checkout results are discarded
  private sentNotices = new Set<string>();
  /** True while the kiosk's build-your-own screen is open: it parses speech itself, so the agents stay out. */
  building = false;
  /** Build-your-own pizzas from the kiosk, priced here from real menu prices (kept apart from the agent's cart). */
  private custom: CartLine[] = [];
  private get allLines() { return [...this.cart, ...this.custom]; }

  /** Kiosk sends its full list of finished build-your-own pizzas whenever it changes. */
  setCustom(pizzas: { size?: string; extras?: string[]; toppings?: unknown[]; qty?: number }[]) {
    const lines: CartLine[] = [];
    const add = (menuId: string, size: string, qty: number, name: string) => {
      const m = MENU_BY_ID.get(menuId);
      const v = m && resolveVariant(m, size);
      if (!m || !v || qty < 1) return console.warn(`[build] no price for ${menuId}/${size}`);
      lines.push({ menu_id: m.id, name, qty, unit_price_cents: v.price_cents, line_total_cents: v.price_cents * qty,
        quote: "build your own", size: v.size, size_label: m.variants.length > 1 ? v.label : null, price_id: v.price_id, defaulted: false });
    };
    for (const p of Array.isArray(pizzas) ? pizzas : []) {
      const size = String(p.size ?? "medium");
      const qty = Math.max(1, Math.min(10, Number(p.qty) || 1));
      add("margherita", size, qty, "Build your own (base, sauce & cheese)");
      for (const x of p.extras ?? []) if (x === "stuffed_crust" || x === "gluten_free_base") add(x, size, qty, MENU_BY_ID.get(x)?.name ?? x);
      const n = Math.min(8, Array.isArray(p.toppings) ? p.toppings.length : 0);
      if (n) add("extra_topping", size, n * qty, "Extra topping");
    }
    this.custom = lines;
    console.log(`[build] custom lines: ${lines.map((l) => `${l.qty}x ${l.menu_id}/${l.size}`).join(", ") || "none"}`);
  }
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

  // ---- speaking ---------------------------------------------------------------------------
  /** Send an already-started TTS clip to the kiosk and remember the line in the dialogue. */
  private sayClip(text: string, clipId: string, turn?: number) {
    this.hasSpoken = true;
    this.dialogue.push(`Kiosk: ${text}`);
    this.speaking = true; // until the kiosk reports otherwise
    this.send({ type: "say", text, audio_url: ttsPath(clipId), id: clipId, turn: turn ?? null });
  }
  /** Speak fixed / server-built text (cached audio for the fixed lines). */
  say(text: string) {
    this.sayClip(text, startTts(text));
  }
  /** Kiosk start: opening narrator line (cached). */
  hello() {
    if (!this.hasSpoken && this.status === "ordering") this.say(GREETING);
  }

  /** Kiosk reports audio actually started playing: log the turn's end-to-end latency. */
  playbackStarted(clipId: string) {
    const t = this.turn?.t;
    if (!t || t.firstClip !== clipId) return;
    const now = Date.now();
    const rel = (x?: number) => (x ? `${x - t.eot}ms` : "-");
    console.log(`[turn] eot→reply token ${rel(t.token)} · →tts first byte ${rel(t.ttsByte)} · →sent ${rel(t.sent)} · →playback ${now - t.eot}ms` +
      (t.end ? ` (eager→EndOfTurn ${t.end - t.eot}ms)` : ""));
  }

  /** Customer talked over the kiosk (barge-in): drop the rest of the reply. */
  bargeIn() {
    this.cancelTurn(true);
  }

  // ---- turn-taking (driven by Flux events, or typed text) ---------------------------------
  liveUpdate(text: string) {
    if (!this.talking) return;
    this.send({ type: "transcript", text, final: false });
    if (this.building || BUILD_OPEN.test(text)) return;
    if (text !== this.live) { this.live = text; this.runAgent(); }
  }

  /** Flux EagerEndOfTurn: start the reply speculatively. */
  eagerEnd(text: string, words: Word[]) {
    if (!this.talking || !meaningful(text, words)) return;
    if (this.building || BUILD_OPEN.test(text)) return;
    this.startReply(text, false);
  }

  /** Flux TurnResumed: the customer kept talking; cancel the speculative reply unplayed. */
  resumed() {
    if (this.turn && !this.turn.committed) this.cancelTurn(false);
  }

  /** Flux EndOfTurn (or a typed message): commit the utterance and release (or start) the reply. */
  endTurn(text: string, words: Word[]) {
    text = text.trim();
    if (!this.talking) { if (text) this.notice("Order already sent to payment — tap Reset to start over."); return; }
    if (!meaningful(text, words)) {
      if (text) console.log(`[turn] ignored as noise: "${text}"`);
      this.live = "";
      if (this.turn && !this.turn.committed) this.cancelTurn(false);
      this.send({ type: "transcript", text: "", final: false });
      return;
    }
    this.send({ type: "transcript", text, final: true });
    if (this.building) { this.live = ""; return; } // the build screen handles this utterance
    if (BUILD_OPEN.test(text)) {
      this.live = "";
      if (this.turn && !this.turn.committed) this.cancelTurn(false);
      this.building = true;
      this.say("Ooh, lovely. Let's build your own. What size are we making?");
      return;
    }
    const turn = this.turn && !this.turn.committed && this.turn.text === text ? this.turn : null;
    this.transcript.push(text);
    this.dialogue.push(`Customer: ${text}`);
    this.live = "";
    this.runAgent();
    if (turn) {
      turn.t.end = Date.now();
      turn.committed = true;
      for (const f of turn.held.splice(0)) f();
    } else {
      this.startReply(text, true);
    }
  }

  private cancelTurn(stopAudio: boolean) {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    t.abort.abort();
    for (const id of t.clips) cancelTts(id);
    if (stopAudio && t.committed) this.send({ type: "stop_speaking" });
  }

  private startReply(text: string, committed: boolean) {
    this.cancelTurn(false);
    const turn: Turn = { id: ++this.turnSeq, text, abort: new AbortController(), clips: [], committed, held: [], t: { eot: Date.now() } };
    this.turn = turn;
    const act = (f: () => void) => {
      if (this.turn !== turn) return;
      if (turn.committed) f(); else turn.held.push(f);
    };
    const status = this.status === "awaiting_confirmation" ? "awaiting_confirmation" : "ordering";
    const hasPizza = this.cart.some((l) => MENU_BY_ID.get(l.menu_id)?.category === "pizza");
    let backToOrdering = false;
    let soFar = "";
    const speak = (s: string, upsell: boolean) => {
      const id = startTts(s, (ms) => { turn.t.ttsByte ??= Date.now(); void ms; });
      turn.clips.push(id);
      act(() => {
        if (status === "awaiting_confirmation" && !backToOrdering) { backToOrdering = true; this.setStatus("ordering"); }
        if (upsell) this.upsellMade = true;
        if (!turn.t.sent) { turn.t.sent = Date.now(); turn.t.firstClip = id; }
        this.sayClip(s, id, turn.id);
      });
    };
    // Fast path: "that's all" etc. goes straight to payment, no LLM call (and never an upsell instead).
    if (status === "ordering" && this.allLines.length && END_RE.test(text)) {
      act(() => void this.readBack());
      return;
    }
    void streamReply(
      {
        oos: outOfStock(),
        cart: [...this.cart.map(spokenLine), ...(this.custom.length ? ["a build-your-own pizza"] : [])].join(", "),
        status,
        upsellAvailable: !this.upsellMade,
        recent: [...this.dialogue.slice(-6), `Customer: ${text}`],
      },
      (e) => {
        if (this.turn !== turn) return;
        if (e.kind === "first_token") turn.t.token = Date.now();
        else if (e.kind === "control") {
          if (e.word === "DONE" && status === "ordering") act(() => void this.readBack());
          else if (e.word === "YES" && status === "awaiting_confirmation") act(() => this.confirmYes());
          else speak(ANYTHING_ELSE, false);
        } else {
          // Guardrail: at most one upsell per order, only with a pizza in the cart. Don't trust the "^" marker alone.
          const upsell = e.upsell || (UPSELL_RE.test(e.text) && !ALTERNATIVE_RE.test(soFar + e.text));
          soFar += ` ${e.text}`;
          if (upsell && (this.upsellMade || !hasPizza)) { console.warn("[reply] drop upsell", e.text); speak(ANYTHING_ELSE, false); }
          else speak(e.text, upsell);
        }
      },
      turn.abort.signal,
    ).catch((e) => {
      if (!turn.abort.signal.aborted) this.error(`Reply agent failed: ${(e as Error).message}`);
    });
  }

  private cartSig() { return this.cart.map((l) => `${l.menu_id}|${l.size}|${l.qty}`).sort().join(","); }

  private confirmYes() {
    if (this.status !== "awaiting_confirmation") return;
    if (this.cartSig() === this.readBackSig) return void this.checkout();
    this.setStatus("ordering");
    void this.readBack(); // cart changed since the read-back: read it again
  }

  /** Resolves once the cart agent has caught up with every committed customer turn (max 6s). */
  private cartSettled(): Promise<void> {
    if (!this.agentBusy && this.cartCovers === this.transcript.join("\n")) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, 6000);
      this.settledWaiters.push(() => { clearTimeout(t); res(); });
    });
  }

  /** Deterministic read-back, built by the server from the priced cart (after the cart agent has caught up). */
  async readBack() {
    if (this.status !== "ordering") return;
    const gen = this.generation;
    await this.cartSettled();
    if (gen !== this.generation || this.status !== "ordering") return;
    if (!this.allLines.length) return this.say("Your basket's empty. What can I get you?");
    const total = this.allLines.reduce((s, l) => s + l.line_total_cents, 0);
    const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: MENU_CURRENCY.toUpperCase() }).format(total / 100);
    // No read-back question: "that's all" goes straight to payment. The total is spoken while the QR is created.
    const text = `Lovely, that comes to ${money}. Bringing up your payment code now.`;
    const t = this.turn?.t;
    const id = startTts(text, () => { if (t) t.ttsByte ??= Date.now(); });
    if (t && !t.sent) { t.sent = Date.now(); t.firstClip = id; }
    this.sayClip(text, id, this.turn?.id);
    void this.checkout(false);
  }

  // ---- cart agent -------------------------------------------------------------------------
  /** At most one in-flight cart call; updates arriving mid-call trigger exactly one re-run with the latest text. */
  private agentTurns() { return this.live ? [...this.transcript, this.live] : [...this.transcript]; }
  private agentKey = ""; // transcript the in-flight call is working on

  private async runAgent() {
    const key = this.agentTurns().join("\n");
    if (this.agentBusy) { if (key !== this.agentKey) this.agentDirty = true; return; }
    if (key === this.cartCovers) return; // cart already reflects exactly this text
    this.agentBusy = true;
    const gen = this.generation;
    try {
      do {
        this.agentDirty = false;
        const turns = this.agentTurns();
        this.agentKey = turns.join("\n");
        const dialogue = this.live ? [...this.dialogue, `Customer: ${this.live}`] : [...this.dialogue];
        let result: AgentResult;
        try {
          result = await reconcile(turns, { dialogue });
        } catch (e) {
          this.error(`Cart agent failed: ${(e as Error).message}`);
          break;
        }
        if (gen !== this.generation || !this.talking) return;
        this.apply(result);
        this.cartCovers = this.agentKey;
      } while (this.agentDirty && gen === this.generation && this.talking && this.agentTurns().join("\n") !== this.cartCovers);
    } finally {
      if (gen === this.generation) {
        this.agentBusy = false;
        for (const f of this.settledWaiters.splice(0)) f();
      }
    }
  }

  /** Live cart update. Changing the cart while awaiting confirmation sends us back to ordering. */
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
    if (this.status === "awaiting_confirmation" && this.cartSig() !== this.readBackSig) this.setStatus("ordering");
    this.pushCart();
    for (const n of r.notices) this.notice(n);
    // The agent re-derives everything from the whole transcript, so the same miss comes back on every later
    // utterance (often with reworded reasons). Tell the customer about each one once.
    for (const u of r.unrecognised) {
      const key = `unrecognised:${u.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      if (this.sentNotices.has(key)) continue;
      this.sentNotices.add(key);
      this.notice(`Sorry, we don't have "${u.text}". ${u.reason}`);
    }
    for (const n of r.needs_confirmation) this.notice(n.question);
  }

  pushCart() {
    const total_cents = this.cart.reduce((s, l) => s + l.line_total_cents, 0);
    this.send({ type: "cart", items: this.cart, total_cents, currency: MENU_CURRENCY });
  }

  /** Kiosk "Done" button: read-back first; a second press while awaiting confirmation goes straight to checkout. */
  done() {
    if (this.status === "awaiting_confirmation") return void this.checkout();
    void this.readBack();
  }


  /** Create the Checkout Session (after a "yes", or {type:"checkout_now"} for testing). */
  async checkout(announce = true) {
    if (!this.talking) return;
    if (!this.allLines.length) return this.notice("Your cart is empty — tell me what you'd like first!");
    this.setStatus("awaiting_payment");
    const gen = this.generation;
    try {
      const cs = await createCheckout(this.orderId, this.allLines);
      if (gen !== this.generation) return;
      this.checkoutId = cs.id;
      this.send({ type: "checkout", url: cs.url });
      if (announce) this.say(SCAN_TO_PAY);
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
    this.say(PAID_LINE);
  }

  reset() {
    this.building = false;
    this.generation++;
    this.cancelTurn(false);
    this.stopPoller();
    byOrder.delete(this.orderId);
    this.orderId = randomUUID();
    byOrder.set(this.orderId, this);
    this.transcript = [];
    this.live = "";
    this.cart = [];
    this.custom = [];
    this.setStatus("ordering");
    this.dialogue = [];
    this.upsellMade = false;
    this.hasSpoken = false;
    this.readBackSig = "";
    this.checkoutId = null;
    this.agentBusy = false;
    this.agentDirty = false;
    this.cartCovers = "";
    this.agentKey = "";
    for (const f of this.settledWaiters.splice(0)) f();
    this.sentNotices.clear();
    this.pushCart();
  }

  dispose() {
    this.generation++;
    this.cancelTurn(false);
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
