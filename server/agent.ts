// Cart agent — "full-cart reconcile": every call sees the WHOLE order transcript and returns
// the WHOLE cart. Corrections ("scrap the margherita") fall out naturally; no diff/patch state.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MENU, MENU_BY_ID } from "./menu.js";

export const MAX_QTY = 10;

const CartSchema = z.object({
  items: z.array(z.object({ menu_id: z.string(), qty: z.number().int(), quote: z.string() })),
  unrecognised: z.array(z.object({ text: z.string(), reason: z.string() })),
  needs_confirmation: z.array(z.object({ menu_id: z.string(), qty: z.number().int(), question: z.string() })),
  order_complete: z.boolean(),
});
export type AgentResult = z.infer<typeof CartSchema>;

const menuText = MENU.map((m) => `- ${m.id}: ${m.name} (also heard as: ${m.aliases.join(", ")})`).join("\n");

const SYSTEM = `You are the order-taking brain of a voice kiosk at a pizza parlour. A customer speaks; you receive the
full speech-to-text transcript of their order so far (one line per utterance, oldest first) and must return the
COMPLETE current cart as JSON. Re-derive the cart from the whole transcript every time.

MENU (menu_id: name):
${menuText}

POLICY — follow strictly:
§1 Menu only. Only menu_ids listed above may appear in "items". Anything the customer asks for that is not on the
   menu (or that you cannot confidently map to one menu item) goes in "unrecognised" with a short reason. Never
   invent or approximate an item. Modifiers you cannot represent (e.g. "no olives", "well done") go in "unrecognised" too.
§2 Evidence. Every cart item must have "quote": a short verbatim substring copied exactly from the transcript that
   justifies that item and quantity (for corrections, quote the correcting phrase, e.g. "make it 2 pepperonis").
§3 Quantity sanity. If the customer wants more than ${MAX_QTY} of a single item, do NOT put it in "items"; put it
   in "needs_confirmation" with a short question to read back (e.g. "Did you really mean 40 Diet Cokes?"). If a
   later utterance confirms it, it still stays in needs_confirmation (staff will handle large orders).
§4 Completion. "order_complete" is true ONLY if the customer clearly signals they are finished ("that's all",
   "that's it", "I'm done", "nothing else") AND the cart is non-empty. Otherwise false.
§5 No prices. Never output or reason about prices or totals — the server prices the cart.

Corrections: later utterances override earlier ones. "Scrap/cancel/remove the X" removes X. "Make it N X" sets
the quantity of X to N. "Another X" / "one more X" increments. Speech-to-text is noisy: "margarita" means
margherita, "pepperonis" is plural pepperoni, numbers may be spelled out. Ignore filler and small talk.
If nothing has been ordered yet, return empty arrays.`;

let client: Anthropic | null = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set — the cart agent can't run");
  return (client ??= new Anthropic());
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Ask Claude for the full cart given the full transcript, then validate server-side. */
export async function reconcile(transcript: string[]): Promise<AgentResult> {
  const t0 = Date.now();
  const response = await getClient().messages.parse({
    model: process.env.CART_MODEL || "claude-haiku-5-5",
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(CartSchema) },
    messages: [{ role: "user", content: `<transcript>\n${transcript.join("\n")}\n</transcript>` }],
  });
  if (response.stop_reason === "refusal") throw new Error("cart agent refused the request");
  const out = response.parsed_output;
  if (!out) throw new Error(`cart agent returned no parseable output (stop_reason=${response.stop_reason})`);
  console.log(`[agent] ${Date.now() - t0}ms`, JSON.stringify(out));
  return validate(out, transcript);
}

/** Enforce policy server-side regardless of what the model said. */
function validate(out: AgentResult, transcript: string[]): AgentResult {
  const haystack = norm(transcript.join(" "));
  const merged = new Map<string, AgentResult["items"][number]>();
  const needs = out.needs_confirmation.filter((n) => MENU_BY_ID.has(n.menu_id));

  for (const it of out.items) {
    const quote = it.quote?.trim();
    if (!MENU_BY_ID.has(it.menu_id)) { console.warn("[agent] drop unknown menu_id", it); continue; } // §1
    if (!quote || !haystack.includes(norm(quote))) { console.warn("[agent] drop unquoted item", it); continue; } // §2
    if (it.qty <= 0) continue;
    const prev = merged.get(it.menu_id);
    merged.set(it.menu_id, prev ? { ...prev, qty: prev.qty + it.qty, quote: `${prev.quote} / ${quote}` } : { ...it, quote });
  }
  const items = [...merged.values()].filter((it) => {
    if (it.qty <= MAX_QTY) return true; // §3
    needs.push({ menu_id: it.menu_id, qty: it.qty, question: `Did you really mean ${it.qty} × ${MENU_BY_ID.get(it.menu_id)!.name}?` });
    return false;
  });
  return { items, unrecognised: out.unrecognised, needs_confirmation: needs, order_complete: out.order_complete && items.length > 0 }; // §4
}
