import Stripe from "stripe";
import { loadPrices, MENU_BY_ID } from "./menu.js";

let stripe: Stripe | null = null;
export function requireStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return (stripe ??= new Stripe(key));
}

export interface CheckoutLine { menu_id: string; name: string; qty: number; quote: string }

/** Stripe metadata values max out at 500 chars. */
function quotesSummary(lines: CheckoutLine[]): string {
  const s = lines.map((l) => `${l.qty}x ${l.menu_id}: "${l.quote}"`).join("; ");
  return s.length <= 500 ? s : s.slice(0, 497) + "...";
}

export async function createCheckout(orderId: string, lines: CheckoutLine[]) {
  const stripe = requireStripe();
  const prices = loadPrices();
  const missing = lines.filter((l) => !prices[l.menu_id]);
  if (missing.length) throw new Error(`No Stripe price for ${missing.map((m) => m.menu_id).join(", ")} — re-run npm run seed`);
  // Currency comes from each Stripe Price itself; Checkout requires them all to match.
  const currencies = new Set(lines.map((l) => MENU_BY_ID.get(l.menu_id)?.currency));
  if (currencies.size > 1) throw new Error(`Cart mixes currencies (${[...currencies].join(", ")}) — fix prices in Stripe`);
  const publicUrl = (process.env.PUBLIC_URL || "http://localhost:5173").replace(/\/$/, "");
  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lines.map((l) => ({ price: prices[l.menu_id], quantity: l.qty })),
    client_reference_id: orderId,
    metadata: { order_id: orderId, quotes: quotesSummary(lines) },
    success_url: `${publicUrl}/paid.html`,
  });
}

export async function isCheckoutPaid(checkoutId: string): Promise<boolean> {
  const cs = await requireStripe().checkout.sessions.retrieve(checkoutId);
  return cs.payment_status === "paid";
}

/** Verify signature and return the event, or throw. `raw` must be the unparsed request body. */
export function verifyWebhook(raw: Buffer, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  if (!signature) throw new Error("missing stripe-signature header");
  return requireStripe().webhooks.constructEvent(raw, signature, secret);
}
