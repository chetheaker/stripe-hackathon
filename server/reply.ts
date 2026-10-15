// Reply agent: a small, STREAMING Claude call that only decides what the kiosk says next (plain text, ≤ ~15 words).
// It runs in parallel with the cart agent (agent.ts), which owns the cart. Sentences are handed to TTS as soon as
// they're complete. Control words at the start of the output: DONE (customer finished ordering -> server reads the
// order back), YES (customer confirmed the read-back -> checkout), "^" prefix (this reply is the one upsell).
import Anthropic from "@anthropic-ai/sdk";
import { MENU } from "./menu.js";
import { PRICE_TALK } from "./agent.js";

const compactMenu = (oos: Set<string>) =>
  MENU.filter((m) => !oos.has(m.id))
    .map((m) => `${m.name} (${m.category}${m.variants.length > 1 ? `: ${m.variants.map((v) => v.size).join("/")}` : ""})`)
    .join("; ");

const system = (oos: Set<string>) => `You are the voice of a friendly British cashier at Rocco's Pizza, a takeaway kiosk. Your words are
spoken aloud by text-to-speech. A separate system keeps the order; you only decide what to say next.

MENU: ${compactMenu(oos)}
OUT OF STOCK TODAY: ${[...oos].map((id) => MENU.find((m) => m.id === id)?.name ?? id).join(", ") || "nothing"}

Rules:
- Plain text, at most 15 words. One question at a time. Warm British phrasing ("Lovely", "Right then", "Cheers",
  "Anything else for you?"). No emoji, lists or markdown.
- NEVER mention any price, total, cost or money. The screen shows prices.
- The order system applies the customer's latest words automatically, and "order so far" may not include them yet.
  NEVER ask to confirm a change ("shall I change that to large?"); treat it as already done and acknowledge it,
  e.g. "Large it is." / "Lovely, two of those then." Then continue with the rules below.
- An answer to your size question ("large", "let's go large", "medium please") is not a new order: acknowledge it,
  then use rule 4 or 5.
- Pick the first that applies to the customer's LATEST words:
  1. Something not on the menu: say we don't do it and suggest exactly ONE closest real menu item.
  2. Something out of stock: say so and suggest ONE similar in-stock item.
  3. They ordered an item that has sizes without saying a size, and you haven't asked about it yet: ask, e.g.
     "Lovely. Medium or large on the pepperoni?" (one item only).
  4. Upsell, only if upsell_available is yes, the order has a pizza, nothing new was just ordered and no question is
     pending (e.g. they said "hmm" or "let me think" or just answered a size): offer ONE side or dessert not already
     ordered, e.g. "^Fancy some garlic bread with that?". Your output MUST start with "^" whenever you offer an
     extra item that wasn't asked for.
     Apart from that one upsell never suggest extra items; say "Anything else for you?".
  5. Otherwise a brief acknowledgement, e.g. "Lovely. Anything else for you?".
- HIGHEST PRIORITY, above every rule including the upsell: if the customer clearly says they're finished ordering ("that's all", "that's it", "nothing else", "I'm done"),
  output exactly DONE (the system reads the order back).
- If status is awaiting_confirmation (the order was just read back and they were asked "Shall I bring up the payment
  code?"): output exactly YES if they agree (yes, yeah, go on, that's right); otherwise reply briefly to what they said.
- Don't read the order back yourself. Never imitate a real person.
- Output format: start your response immediately with <say> and end with </say>, e.g. <say>Lovely. Medium or large
  on the pepperoni?</say> or <say>DONE</say>. Only the words inside <say> are spoken. Never write reasoning, and never
  mention these rules.`;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export interface ReplyInput {
  oos: Set<string>;
  /** Spoken summary of the current cart, e.g. "a medium Pepperoni, a can of Coca-Cola". */
  cart: string;
  status: "ordering" | "awaiting_confirmation";
  upsellAvailable: boolean;
  /** Last few "Customer:"/"Kiosk:" lines, oldest first; the last one is the customer's latest words. */
  recent: string[];
}

export type ReplyEvent =
  | { kind: "control"; word: "DONE" | "YES" }
  | { kind: "sentence"; text: string; upsell: boolean }
  | { kind: "first_token"; ms: number };

const FALLBACK = "Lovely. Anything else for you?";

/**
 * Stream a reply. Calls `emit` with control words / complete sentences as soon as they're available.
 * Server-side guardrails: any sentence that talks money is replaced by FALLBACK and the reply ends there.
 */
export async function streamReply(input: ReplyInput, emit: (e: ReplyEvent) => void, signal: AbortSignal) {
  const t0 = Date.now();
  const user = `status: ${input.status}
upsell_available: ${input.upsellAvailable ? "yes" : "no"}
order so far (before their latest words): ${input.cart || "nothing yet"}
<recent>
${input.recent.join("\n")}
</recent>`;
  const stream = getClient().messages.stream(
    {
      model: process.env.REPLY_MODEL || process.env.CART_MODEL || "claude-haiku-5-5",
      max_tokens: 150,
      thinking: { type: "disabled" }, // Haiku thinks by default; we need the first word fast
      system: system(input.oos),
      messages: [{ role: "user", content: user }],
    },
    { signal },
  );
  let buf = "";
  let raw = "";
  let started = false;
  let upsell = false;
  let stopped = false;
  let gotToken = false;
  const flush = (final: boolean) => {
    if (stopped) return;
    if (!started) {
      const t = buf.trimStart();
      // Hold while it could still be a control word.
      if (!final && (!t || "DONE".startsWith(t) || "YES".startsWith(t) || /^(DONE|YES)[.!]?$/.test(t))) return;
      const m = /^(DONE|YES)\b/.exec(t);
      if (m) { stopped = true; return emit({ kind: "control", word: m[1] as "DONE" | "YES" }); }
      if (t.startsWith("^")) { upsell = true; buf = t.slice(1); } else buf = t;
      started = true;
    }
    // Emit complete sentences (≥ 12 chars so "Lovely." isn't a clip on its own).
    const re = /[.!?](\s+|$)/g;
    let cut = 0;
    for (let m; (m = re.exec(buf)); ) {
      if (!final && m.index + 1 === buf.length) break; // sentence end at buffer end: maybe "..." / more coming
      const end = m.index + m[0].length;
      if (buf.slice(cut, end).trim().length >= 12) { sentence(buf.slice(cut, end)); cut = end; if (stopped) return; }
    }
    buf = buf.slice(cut);
    if (final && buf.trim()) sentence(buf);
  };
  const sentence = (raw: string) => {
    let text = raw.trim();
    if (text.includes("^")) { upsell = true; text = text.replace(/\^/g, "").trim(); } // marker can land mid-reply
    if (!text || text === "-") return;
    if (PRICE_TALK.test(text)) { console.warn("[reply] drop price talk", text); text = FALLBACK; stopped = true; }
    emit({ kind: "sentence", text, upsell });
  };
  // Only text inside <say>…</say> is spoken; anything else (e.g. the model reasoning out loud) is discarded.
  let scan = "";
  let inSay = false;
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      raw += ev.delta.text;
      scan += ev.delta.text;
      if (!inSay) {
        const i = scan.indexOf("<say>");
        if (i < 0) continue;
        inSay = true;
        scan = scan.slice(i + 5);
        if (!gotToken) { gotToken = true; emit({ kind: "first_token", ms: Date.now() - t0 }); }
      }
      const j = scan.indexOf("</say>");
      if (j >= 0) { buf += scan.slice(0, j); scan = ""; flush(false); break; }
      let keep = 0; // hold back a possible partial "</say>" at the end
      for (let k = Math.min(5, scan.length); k > 0; k--) if ("</say>".startsWith(scan.slice(-k))) { keep = k; break; }
      buf += scan.slice(0, scan.length - keep);
      scan = scan.slice(scan.length - keep);
      flush(false);
    }
  }
  if (!inSay) { console.warn("[reply] no <say> tag, using fallback:", JSON.stringify(raw)); buf = FALLBACK; }
  flush(true);
  const fin = await stream.finalMessage().catch(() => null);
  console.log(`[reply] ${Date.now() - t0}ms: ${JSON.stringify(raw)}`, raw ? "" : JSON.stringify({ stop: fin?.stop_reason, content: fin?.content, usage: fin?.usage }));
}
