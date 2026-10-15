import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One purchasable size of a product = one active Stripe Price. */
export interface Variant {
  /** Machine size key, from price metadata.size or lookup_key suffix (e.g. "small", "medium", "can", "twelve"). */
  size: string;
  /** Human label, e.g. `Large 14"`, `330ml can`, `6 wings`. */
  label: string;
  /** Smallest currency unit (pence, cents, ...), from the Price's unit_amount. */
  price_cents: number;
  price_id: string;
  /** Exactly one variant per item is the default (used when the customer doesn't say a size). */
  default?: true;
}

export interface MenuItem {
  id: string;
  name: string;
  aliases: string[];
  /** ISO currency code from the Stripe Prices, lowercase (e.g. "gbp"). */
  currency: string;
  /** From Stripe product metadata.category (pizza, side, drink, dip, dessert, ...). */
  category: string;
  /** Sorted cheapest first. */
  variants: Variant[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(here, "..", "data");
export const MENU_PATH = path.join(DATA_DIR, "menu.json");

export function readMenuFile(): MenuItem[] {
  return fs.existsSync(MENU_PATH) ? JSON.parse(fs.readFileSync(MENU_PATH, "utf8")) : [];
}

export const MENU: MenuItem[] = readMenuFile();
export const MENU_BY_ID = new Map(MENU.map((m) => [m.id, m]));
/** The menu's single currency (Checkout can't mix currencies). Falls back to "gbp" for an empty menu. */
export const MENU_CURRENCY = MENU[0]?.currency ?? "gbp";

export const defaultVariant = (m: MenuItem): Variant => m.variants.find((v) => v.default) ?? m.variants[0];

/** Spoken size words -> size keys they can mean (checked in order against the item's variants). */
const SIZE_SYNONYMS: Record<string, string[]> = {
  big: ["large"], large: ["large"], biggest: ["large"],
  small: ["small"], little: ["small"], smallest: ["small"],
  medium: ["medium", "regular"], regular: ["medium", "regular"], normal: ["medium", "regular"],
  can: ["can"], tin: ["can"], "330ml": ["can"],
  bottle: ["bottle"], "big bottle": ["bottle"], "1.5l": ["bottle"], "1.5 litre": ["bottle"], "1.5 liter": ["bottle"],
  "12": ["twelve"], twelve: ["twelve"], "12 wings": ["twelve"],
  "6": ["six"], six: ["six"], "6 wings": ["six"],
};

/** Resolve a size the model/customer gave to one of the item's variants, or null if it doesn't fit. */
export function resolveVariant(m: MenuItem, size: string): Variant | null {
  const s = size.toLowerCase().trim();
  for (const key of [s, ...(SIZE_SYNONYMS[s] ?? [])]) {
    const v = m.variants.find((v) => v.size === key);
    if (v) return v;
  }
  return m.variants.find((v) => v.label.toLowerCase() === s) ?? null;
}

const SIZE_KEYTERMS = ["large", "medium", "small", "regular", "can", "bottle", "1.5 litre", "12 wings", "6 wings"];

/**
 * Words Deepgram should be biased towards: item names, size words, then aliases; case-insensitively deduped and
 * capped (nova-3 keyterm prompting is limited to ~500 tokens; we stay well under).
 */
export const KEYTERMS = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  let words = 0;
  for (const term of [...MENU.map((m) => m.name), ...SIZE_KEYTERMS, ...MENU.flatMap((m) => m.aliases)]) {
    const key = term.toLowerCase();
    const w = term.split(/\s+/).length;
    if (seen.has(key) || words + w > 250) continue;
    seen.add(key);
    out.push(term);
    words += w;
  }
  return out;
})();
