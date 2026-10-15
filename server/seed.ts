// READ-ONLY sync: Stripe catalog -> data/menu.json (items + size variants with their Stripe price ids).
// Stripe is the source of truth. This script only lists products/prices; it never creates, updates or deletes anything.
//
// - Every ACTIVE product with metadata.menu_id becomes a menu item (others are skipped with a note).
// - Every active one-time Price becomes a size variant (size from price metadata.size or lookup_key suffix, label from
//   the nickname). One variant is the default: default_price if set, else the middle of 3, else the cheapest.
// - name / prices / currency come from Stripe; category from product metadata (else existing / inferred).
// - Existing aliases are preserved; new items get generated aliases. Items with no active Stripe product are dropped.
import "dotenv/config";
import fs from "node:fs";
import type Stripe from "stripe";
import path from "node:path";
import { DATA_DIR, MENU_PATH, readMenuFile, type MenuItem, type Variant } from "./menu.js";
import { requireStripe } from "./stripe.js";

const stripe = requireStripe();
const LEGACY_PRICES_PATH = path.join(DATA_DIR, "prices.json");
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
  doner_special: ["doner", "doner pizza", "donner", "donor", "donor special", "donna special", "doner kebab", "kebab", "kebab pizza", "special"],
  chicken_tikka: ["tikka", "tika", "chicken tika", "tikka pizza", "chicken ticker"],
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

const labelOf = (p: Stripe.Price, size: string) =>
  p.nickname?.match(/\(([^)]*)\)\s*$/)?.[1] ?? size.charAt(0).toUpperCase() + size.slice(1);

/**
 * All active one-time prices become variants (cheapest first). Default: the product's default_price if set and
 * active; else the middle one when there are 3 (pizzas -> Medium), else the cheapest (drinks -> can, wings -> 6).
 */
async function variantsFor(product: Stripe.Product, id: string): Promise<{ variants: Variant[]; currency: string }> {
  const active: Stripe.Price[] = [];
  for await (const p of stripe.prices.list({ product: product.id, active: true, type: "one_time", limit: 100 })) {
    if (p.unit_amount != null) active.push(p);
  }
  active.sort((a, b) => a.unit_amount! - b.unit_amount!);
  const used = new Set<string>();
  const variants: Variant[] = active.map((p) => {
    let size = (p.metadata.size || p.lookup_key?.replace(new RegExp(`^${id}_`), "") || "regular").toLowerCase();
    if (used.has(size)) { warnings.push(`${id}: duplicate size "${size}" on ${p.id} — renamed to ${p.id}`); size = p.id; }
    used.add(size);
    return { size, label: labelOf(p, size), price_cents: p.unit_amount!, price_id: p.id };
  });
  if (!variants.length) return { variants, currency: "" };
  const dp = typeof product.default_price === "string" ? product.default_price : product.default_price?.id;
  const def = variants.find((v) => v.price_id === dp) ?? variants[variants.length === 3 ? 1 : 0];
  def.default = true;
  const cur = new Set(active.map((p) => p.currency));
  if (cur.size > 1) warnings.push(`${id}: prices in several currencies (${[...cur].join(", ")})`);
  return { variants, currency: active.find((p) => p.id === def.price_id)!.currency };
}

const menu: MenuItem[] = [];

for await (const product of stripe.products.list({ active: true, limit: 100 })) {
  const id = product.metadata.menu_id;
  if (!id) { skipped.push(`${product.id} "${product.name}" (no metadata.menu_id)`); continue; }
  if (menu.some((m) => m.id === id)) { warnings.push(`duplicate menu_id "${id}" on ${product.id} "${product.name}" — ignored`); continue; }
  const { variants, currency } = await variantsFor(product, id);
  if (!variants.length) { warnings.push(`${id}: no active one-time price — skipped`); continue; }
  const prev = existing.get(id);
  menu.push({
    id,
    name: product.name,
    aliases: prev?.aliases ?? generatedAliases(id, product.name),
    currency,
    category: product.metadata.category || prev?.category || inferCategory(product.name),
    variants,
  });
}

const currencies = new Set(menu.map((m) => m.currency));
if (currencies.size > 1) warnings.push(`menu mixes currencies (${[...currencies].join(", ")}) — a single Checkout can't mix them`);
const synced = new Set(menu.map((m) => m.id));
const dropped = [...existing.keys()].filter((id) => !synced.has(id));

const CAT_ORDER = ["meal_deal", "pizza", "pizza_extra", "side", "dip", "dessert", "drink"];
const rank = (c: string) => (CAT_ORDER.includes(c) ? CAT_ORDER.indexOf(c) : CAT_ORDER.length);
menu.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));

fs.writeFileSync(MENU_PATH, "[\n" + menu.map((m) => "  " + JSON.stringify(m)).join(",\n") + "\n]\n");
if (fs.existsSync(LEGACY_PRICES_PATH)) fs.rmSync(LEGACY_PRICES_PATH); // superseded: price ids now live in menu.json

const money = (c: number) => (c / 100).toFixed(2);
console.table(
  menu.map((m) => ({
    id: m.id, name: m.name, category: m.category, currency: m.currency,
    sizes: m.variants.map((v) => `${v.default ? "*" : ""}${v.size} ${money(v.price_cents)}`).join(" | "),
    new: existing.has(m.id) ? "" : "new",
  })),
);
console.log("(* = default size)");
if (dropped.length) console.log(`\nDropped (no active Stripe product): ${dropped.join(", ")}`);
if (skipped.length) console.log(`\nSkipped:\n  ${skipped.join("\n  ")}`);
if (warnings.length) console.warn(`\nWarnings:\n  ${warnings.join("\n  ")}`);
console.log(`\nSynced ${menu.length} items. Wrote ${MENU_PATH} (read-only against Stripe).`);
