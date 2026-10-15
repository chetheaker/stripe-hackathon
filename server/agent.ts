// Cart agent — "full-cart reconcile": every call sees the WHOLE order transcript and returns
// the WHOLE cart. Corrections ("scrap the margherita") fall out naturally; no diff/patch state.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, MENU, MENU_BY_ID, defaultVariant, resolveVariant } from "./menu.js";

export const MAX_QTY = 10;

const CartSchema = z.object({
  items: z.array(z.object({ menu_id: z.string(), size: z.string().nullable(), qty: z.number().int(), quote: z.string() })),
  unrecognised: z.array(z.object({ text: z.string(), reason: z.string() })),
  needs_confirmation: z.array(z.object({ menu_id: z.string(), qty: z.number().int(), question: z.string() })),
  order_complete: z.boolean(),
  /** What the kiosk should say out loud now (≤ ~15 words), or null to stay quiet. */
  reply: z.string().nullable(),
  /** True if `reply` offers an extra item (the one allowed upsell). */
  upsell_offered: z.boolean(),
  /** Only when awaiting confirmation of the read-back: the customer's answer. */
  confirm: z.enum(["yes", "no"]).nullable(),
});
type ModelOutput = z.infer<typeof CartSchema>;

/** A validated cart line: size is always a real variant of the item; `defaulted` = customer didn't say a size. */
export interface ResolvedItem { menu_id: string; size: string; qty: number; quote: string; defaulted: boolean }
export interface AgentResult extends Omit<ModelOutput, "items"> {
  items: ResolvedItem[];
  /** Server-side corrections to tell the customer about (e.g. a size that doesn't exist for that item). */
  notices: string[];
}

/** data/out-of-stock.json: array of menu ids that can't be ordered today. Re-read on every call so it can be edited live. */
const OOS_PATH = path.join(DATA_DIR, "out-of-stock.json");
export function outOfStock(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(OOS_PATH, "utf8")) as string[]); } catch { return new Set(); }
}

const sizesText = (m: (typeof MENU)[number]) =>
  m.variants.length < 2
    ? "one size"
    : "sizes: " + m.variants.map((v) => `${v.size} = ${v.label}${v.default ? " [default]" : ""}`).join(", ");
const menuText = (oos: Set<string>) =>
  MENU.map((m) => `- ${m.id}: ${m.name} [${m.category}] — ${sizesText(m)} (also heard as: ${m.aliases.join(", ")})${oos.has(m.id) ? " — OUT OF STOCK TODAY" : ""}`).join("\n");

const system = (oos: Set<string>) => `You are the order-taking brain of a voice kiosk at a pizza parlour. A customer speaks; you receive the
full dialogue so far, oldest first: "Customer:" lines are speech-to-text of the customer (one per utterance),
"Kiosk:" lines are what the kiosk said back. Return the COMPLETE current cart as JSON. Re-derive the cart from the
whole dialogue every time (the "transcript" below means the Customer lines).

MENU (menu_id: name — sizes as size_key = label):
${menuText(oos)}

POLICY — follow strictly:
§1 Menu only. Only menu_ids listed above may appear in "items". Anything the customer asks for that is not on the
   menu (or that you cannot confidently map to one menu item) goes in "unrecognised" with a short reason. Never
   invent or approximate an item. Modifiers you cannot represent (e.g. "no olives", "well done") go in "unrecognised" too.
§2 Evidence. Every cart item must have "quote": a short verbatim substring copied exactly from a Customer line that
   justifies that item and quantity (for corrections, quote the correcting phrase, e.g. "make it 2 pepperonis").
§3 Quantity sanity. If the customer wants more than ${MAX_QTY} of a single item, do NOT put it in "items"; put it
   in "needs_confirmation" with a short question to read back (e.g. "Did you really mean 40 Diet Cokes?"). If a
   later utterance confirms it, it still stays in needs_confirmation (staff will handle large orders).
§4 Completion. "order_complete" is true ONLY if the customer clearly signals they are finished ("that's all",
   "that's it", "I'm done", "nothing else") AND the cart is non-empty. Otherwise false.
§5 Sizes. Each item has "size": one of that item's size keys, exactly as listed, when the customer states a size,
   otherwise null (the server applies the [default]). Never guess a size the customer didn't say. Synonyms:
   "big"/"large" -> large; "small"/"little" -> small; "regular"/"medium"/"normal" -> medium (or regular);
   "can" -> can; "bottle"/"big bottle"/"1.5 litre" -> bottle; "12 wings"/"twelve" -> twelve; "6 wings" -> six.
   For single-size items use null. Different sizes of the same item are separate entries ("a large and a small
   pepperoni" = two entries). Size corrections ("make it large", "actually make the pepperonis small") change the
   size of the existing entry; they do NOT add a new one. When a size is stated, the quote must include the size
   word(s) (e.g. "a large pepperoni", "make it a large").
§6 No prices. Never output or reason about prices or totals — the server prices the cart.

Corrections: later utterances override earlier ones. "Scrap/cancel/remove the X" removes X. "Make it N X" sets
the quantity of X to N. "Another X" / "one more X" increments. Speech-to-text is noisy: "margarita" means
margherita, "pepperonis" is plural pepperoni, numbers may be spelled out. Ignore filler and small talk.
If nothing has been ordered yet, return empty arrays.
§7 Out of stock. Items marked OUT OF STOCK TODAY must never go in "items"; put them in "unrecognised" (reason
   "out of stock today") and, in "reply", say so and suggest one similar in-stock item.
§4b "order_complete" refers to the LATEST customer utterance only (an earlier "that's all" followed by more ordering
   does not count).

SPEAKING — you are also the kiosk's voice: a friendly British cashier. "reply" is spoken aloud by text-to-speech.
- At most ~15 words. One question at a time. Warm, natural British phrasing ("Lovely", "Right then",
  "Anything else for you?", "Cheers"). No emoji, no lists, no markdown.
- NEVER mention any price, total, cost or amount of money. The screen shows prices.
- Priority for what to say (pick the first that applies to the LATEST customer utterance):
  1. Something they asked for is not on the menu: say we don't do it and suggest the ONE closest real menu item
     (e.g. a pizza for food, a drink for a drink). This is not an upsell: upsell_offered=false.
  2. Something is out of stock: say so and suggest one similar in-stock item.
  3. They ordered an item with several sizes without saying a size (its size is null) and you haven't asked about
     that item yet in the dialogue: ask, e.g. "Medium or large on the pepperoni?". Ask about one item only.
  4. Upsell (only when rules 1-3 don't apply to this utterance, upsell_available is yes, the cart has at least one pizza, and the customer has paused without
     a question pending): offer ONE side or dessert that is not already in the cart, e.g. "Fancy some garlic bread
     with that?", and set upsell_offered=true. Only add it to the cart if they then say yes.
     Never upsell in the same reply that acknowledges a new item; wait for a later, quieter turn (a pause,
     "hmm", "let me think", or an acknowledgement with nothing new).
  Apart from that one upsell, never suggest or ask about extra items (no "would you like a drink?"); use
  "Anything else for you?".
  5. Otherwise a brief acknowledgement ("Lovely. Anything else for you?") or null if nothing useful to say.
- If first_reply is yes, you may open with ONE short, light nature-documentary narrator line before the rest
  (e.g. "Ah. A hungry customer approaches."). Never imitate a real person. Keep the total short.
- Set upsell_offered=false unless your reply is an upsell offer.
- If status is awaiting_confirmation, the kiosk just read the order back and asked "Shall I bring up the payment
  code?". Set "confirm" to "yes" if the latest utterance agrees (yes / yeah / go on / that's right), "no" if it
  declines or changes the order, else null. Reply briefly (the server handles the payment code). Otherwise confirm=null.
- Don't read the order back yourself; the server does that when order_complete is true.`;

let client: Anthropic | null = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set — the cart agent can't run");
  return (client ??= new Anthropic());
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Ask Claude for the full cart given the full transcript, then validate server-side. */
export interface TurnContext {
  /** Interleaved "Customer: ..." / "Kiosk: ..." lines, oldest first. */
  dialogue: string[];
  status: "ordering" | "awaiting_confirmation";
  upsellAvailable: boolean;
  firstReply: boolean;
}

export async function reconcile(transcript: string[], ctx: TurnContext): Promise<AgentResult> {
  const t0 = Date.now();
  const oos = outOfStock();
  const input = `<dialogue>\n${ctx.dialogue.join("\n")}\n</dialogue>
status: ${ctx.status}
upsell_available: ${ctx.upsellAvailable ? "yes" : "no"}
first_reply: ${ctx.firstReply ? "yes" : "no"}`;
  const response = await getClient().messages.parse({
    model: process.env.CART_MODEL || "claude-haiku-5-5",
    max_tokens: 4000,
    system: system(oos),
    output_config: { effort: "low", format: zodOutputFormat(CartSchema) },
    messages: [{ role: "user", content: input }],
  });
  if (response.stop_reason === "refusal") throw new Error("cart agent refused the request");
  const out = response.parsed_output;
  if (!out) throw new Error(`cart agent returned no parseable output (stop_reason=${response.stop_reason})`);
  console.log(`[agent] ${Date.now() - t0}ms`, JSON.stringify(out));
  return validate(out, transcript, oos, ctx);
}

const PRICE_TALK = /£|\$|€|\bpounds?\b|\bquid\b|\bpence\b|\d+p\b|\bcosts?\b|\btotal\b/i;

/** Enforce policy server-side regardless of what the model said. */
function validate(out: ModelOutput, transcript: string[], oos: Set<string>, ctx: TurnContext): AgentResult {
  const haystack = norm(transcript.join(" "));
  const merged = new Map<string, ResolvedItem>(); // key: menu_id|size
  const needs = out.needs_confirmation.filter((n) => MENU_BY_ID.has(n.menu_id));
  const notices: string[] = [];

  for (const it of out.items) {
    const quote = it.quote?.trim();
    const m = MENU_BY_ID.get(it.menu_id);
    if (!m) { console.warn("[agent] drop unknown menu_id", it); continue; } // §1
    if (oos.has(m.id)) { notices.push(`Sorry, ${m.name} is out of stock today.`); continue; } // §7
    if (!quote || !haystack.includes(norm(quote))) { console.warn("[agent] drop unquoted item", it); continue; } // §2
    if (it.qty <= 0) continue;
    // §5: size must be one of this item's variants; null / invalid -> default.
    let v = it.size ? resolveVariant(m, it.size) : null;
    if (it.size && !v && m.variants.length > 1) {
      notices.push(`${m.name} doesn't come in "${it.size}" — using ${defaultVariant(m).label}.`);
    }
    const defaulted = !v && m.variants.length > 1;
    v ??= defaultVariant(m);
    const key = `${m.id}|${v.size}`;
    const prev = merged.get(key);
    merged.set(key, prev
      ? { ...prev, qty: prev.qty + it.qty, quote: `${prev.quote} / ${quote}`, defaulted: prev.defaulted && defaulted }
      : { menu_id: m.id, size: v.size, qty: it.qty, quote, defaulted });
  }
  const items = [...merged.values()].filter((it) => {
    if (it.qty <= MAX_QTY) return true; // §3
    const m = MENU_BY_ID.get(it.menu_id)!;
    const size = m.variants.length > 1 ? ` (${resolveVariant(m, it.size)!.label})` : "";
    needs.push({ menu_id: it.menu_id, qty: it.qty, question: `Did you really mean ${it.qty} × ${m.name}${size}?` });
    return false;
  });
  // Speech guardrails: the LLM never states prices; at most one upsell per order, and only once there's a pizza.
  let reply = out.reply?.trim() || null;
  let upsell = out.upsell_offered && !!reply;
  if (reply && PRICE_TALK.test(reply)) { console.warn("[agent] drop price talk", reply); reply = "Lovely. Anything else for you?"; upsell = false; }
  const hasPizza = items.some((it) => MENU_BY_ID.get(it.menu_id)?.category === "pizza");
  if (upsell && (!ctx.upsellAvailable || !hasPizza)) { console.warn("[agent] drop upsell", reply); reply = "Lovely. Anything else for you?"; upsell = false; }
  return {
    items, unrecognised: out.unrecognised, needs_confirmation: needs, notices,
    order_complete: out.order_complete && items.length > 0, // §4
    reply, upsell_offered: upsell, confirm: ctx.status === "awaiting_confirmation" ? out.confirm : null,
  };
}
