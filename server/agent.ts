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
   Customers often say just part of a name: if a word or phrase matches the name or an alias of exactly ONE menu
   item, that IS the item ("a tikka" = chicken_tikka, "a special" = doner_special).
   Speech-to-text also mangles names ("donor"/"donna" = doner); map sound-alikes to the obvious item.
   "unrecognised" lists only requests that still stand at the end of the transcript: if the customer later replaced,
   rephrased or dropped it ("actually a tikka instead", "forget that"), leave it out. "reason" is shown to the
   customer: one short, friendly sentence, no jargon (e.g. "That's not on our menu." or "We can't do half-and-half.").
§2 Evidence. Every cart item must have "quote": a short verbatim substring copied exactly from a Customer line that
   justifies that item and quantity (for corrections, quote the correcting phrase, e.g. "make it 2 pepperonis").
§3 Quantity sanity. If the customer wants more than ${MAX_QTY} of a single item, do NOT put it in "items"; put it
   in "needs_confirmation" with a short question to read back (e.g. "Did you really mean 40 Diet Cokes?"). If a
   later utterance confirms it, it still stays in needs_confirmation (staff will handle large orders).
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
   "out of stock today").
Upsell: if the Kiosk offered an extra item, only add it if the customer then said yes to it.`;

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
}

export async function reconcile(transcript: string[], ctx: TurnContext): Promise<AgentResult> {
  const t0 = Date.now();
  const oos = outOfStock();
  const input = `<dialogue>\n${ctx.dialogue.join("\n")}\n</dialogue>`;
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
  return validate(out, transcript, oos);
}

export const PRICE_TALK = /£|\$|€|\bpounds?\b|\bquid\b|\bpence\b|\d+p\b|\bcosts?\b|\btotal\b/i;

/** Enforce policy server-side regardless of what the model said. */
function validate(out: ModelOutput, transcript: string[], oos: Set<string>): AgentResult {
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
  return { items, unrecognised: out.unrecognised, needs_confirmation: needs, notices };
}
