// READ-ONLY sync: Stripe catalog -> data/menu.json + data/prices.json.
// Stripe is the source of truth. This script only lists products/prices; it never creates, updates or deletes anything.
//
// - Every ACTIVE product with metadata.menu_id becomes a menu item (others are skipped with a note).
// - Price chosen per product: default_price if set and active; else the only active one-time price; else (several)
//   the most recently created active one-time price, with a warning.
// - name / price_cents / currency come from Stripe; category from product metadata (else existing / inferred).
// - Existing aliases are preserved; new items get generated aliases. Items with no active Stripe product are dropped.
import "dotenv/config";
import fs from "node:fs";
import type Stripe from "stripe";
import { MENU_PATH, PRICES_PATH, readMenuFile, type MenuItem } from "./menu.js";
import { requireStripe } from "./stripe.js";

const stripe = requireStripe();
const existing = new Map(readMenuFile().map((m) => [m.id, m]));
const warnings: string[] = [];
const skipped: string[] = [];

/** Hand-picked aliases (speech-to-text variants) for items seeded for the first time. */
const ALIAS_HINTS: Record<string, string[]> = {
  margherita: ["margarita", "margaritas"],
  pepperoni: ["pepperonis", "peperoni"],
  hawaiian: ["ham and pineapple"],
  bbq_chicken: ["barbecue chicken"],
  coca_cola: ["coke", "coca cola", "cokes", "regular coke"],
  diet_coke: ["diet cokes", "diet coca cola"],
  coke_zero: ["coke zero", "coke zeros", "coca cola zero"],
  fanta_orange: ["fanta", "orange fanta"],
  still_water: ["water", "bottle of water", "still waters"],
  chicken_wings: ["wings", "chicken wing"],
  chips: ["fries", "french fries"],
  cheesy_chips: ["cheese chips", "cheesy fries"],
  potato_wedges: ["wedges"],
  mozzarella_sticks: ["mozzarella sticks", "mozzarella stick", "mozza sticks"],
  chicken_strips: ["chicken strip", "chicken tenders"],
  onion_rings: ["onion ring"],
  garlic_and_herb_dip: ["garlic dip", "garlic and herb dip", "garlic and herb"],
  bbq_dip: ["barbecue dip"],
  hot_buffalo_dip: ["buffalo dip"],
  vegetarian_supreme: ["veggie", "vegetarian", "veggie supreme"],
  vegan_garden: ["vegan", "vegan pizza"],
  hot_and_spicy: ["hot and spicy", "spicy pizza"],
  nduja_hot_honey: ["nduja", "nduja and hot honey", "hot honey"],
  doner_special: ["doner", "doner pizza", "donner"],
  ice_cream_tub: ["ben and jerry's", "ben and jerrys", "ice cream"],
  chocolate_fudge_cake: ["chocolate cake", "fudge cake"],
  warm_cookie_dough: ["cookie dough"],
  stuffed_crust: ["stuffed crust"],
  gluten_free_base: ["gluten free", "gluten free base"],
  extra_topping: ["extra topping", "extra toppings"],
  family_feast: ["family deal"],
  meal_for_two: ["meal for 2", "deal for two"],
  solo_deal: ["solo meal", "meal for one"],
};

function inferCategory(name: string): string {
  const n = name.toLowerCase();
  if (/(cola|coke|water|sprite|fanta|lemonade|juice)/.test(n)) return "drink";
  if (/(dip)/.test(n)) return "dip";
  if (/(cake|cookie|ice cream|brownie)/.test(n)) return "dessert";
  if (/(bread|chips|wings|salad|rings|sticks|strips|wedges|slaw)/.test(n)) return "side";
  return "pizza";
}

function generatedAliases(id: string, name: string): string[] {
  const base = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([base, id.replace(/_/g, " "), ...(ALIAS_HINTS[id] ?? [])])];
}

async function pickPrice(product: Stripe.Product): Promise<Stripe.Price | null> {
  const dp = product.default_price;
  if (dp) {
    const price = typeof dp === "string" ? await stripe.prices.retrieve(dp) : dp;
    if (price.active) return price;
  }
  // Stripe lists newest first, so on equal `created` seconds the list order is the true creation order.
  const active: Stripe.Price[] = [];
  for await (const p of stripe.prices.list({ product: product.id, active: true, type: "one_time", limit: 100 })) active.push(p);
  active.sort((a, b) => b.created - a.created); // stable: keeps API order on ties
  if (active.length > 1) {
    const label = (p: Stripe.Price) => `${p.nickname ?? p.id} ${(p.unit_amount ?? 0) / 100} ${p.currency}`;
    warnings.push(
      `${product.metadata.menu_id}: ${active.length} active prices, no default_price — picked newest "${label(active[0])}" ` +
        `(others: ${active.slice(1).map(label).join("; ")})`,
    );
  }
  return active[0] ?? null;
}

const menu: MenuItem[] = [];
const prices: Record<string, string> = {};

for await (const product of stripe.products.list({ active: true, limit: 100 })) {
  const id = product.metadata.menu_id;
  if (!id) { skipped.push(`${product.id} "${product.name}" (no metadata.menu_id)`); continue; }
  if (prices[id]) { warnings.push(`duplicate menu_id "${id}" on ${product.id} "${product.name}" — ignored`); continue; }
  const price = await pickPrice(product);
  if (!price || price.unit_amount == null) { warnings.push(`${id}: no usable active one-time price — skipped`); continue; }
  const prev = existing.get(id);
  menu.push({
    id,
    name: product.name,
    aliases: prev?.aliases ?? generatedAliases(id, product.name),
    price_cents: price.unit_amount,
    currency: price.currency,
    category: product.metadata.category || prev?.category || inferCategory(product.name),
  });
  prices[id] = price.id;
}

const currencies = new Set(menu.map((m) => m.currency));
if (currencies.size > 1) warnings.push(`menu mixes currencies (${[...currencies].join(", ")}) — a single Checkout can't mix them`);
const dropped = [...existing.keys()].filter((id) => !prices[id]);

const CAT_ORDER = ["meal_deal", "pizza", "pizza_extra", "side", "dip", "dessert", "drink"];
const rank = (c: string) => (CAT_ORDER.includes(c) ? CAT_ORDER.indexOf(c) : CAT_ORDER.length);
menu.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));

fs.writeFileSync(MENU_PATH, "[\n" + menu.map((m) => "  " + JSON.stringify(m)).join(",\n") + "\n]\n");
fs.writeFileSync(PRICES_PATH, JSON.stringify(prices, null, 2) + "\n");

console.table(
  menu.map((m) => ({
    id: m.id, name: m.name, category: m.category,
    price: (m.price_cents / 100).toFixed(2), currency: m.currency, price_id: prices[m.id], new: existing.has(m.id) ? "" : "new",
  })),
);
if (dropped.length) console.log(`\nDropped (no active Stripe product): ${dropped.join(", ")}`);
if (skipped.length) console.log(`\nSkipped:\n  ${skipped.join("\n  ")}`);
if (warnings.length) console.warn(`\nWarnings:\n  ${warnings.join("\n  ")}`);
console.log(`\nSynced ${menu.length} items. Wrote ${MENU_PATH} and ${PRICES_PATH} (read-only against Stripe).`);
