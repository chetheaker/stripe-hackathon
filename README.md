# 🍕 Voice-to-Pay Pizza Kiosk

Customer speaks their order at a kiosk → live transcript → Claude keeps the cart up to date (including corrections like
*"scrap the margherita, make it 2 pepperonis"*) → *"that's all"* → Stripe Checkout QR code → pay on phone →
kiosk shows **Payment successful — next customer please** and resets after 5 s.

## Setup

Requires Node 20+ and the [Stripe CLI](https://docs.stripe.com/stripe-cli) (for webhooks).

```bash
cp .env.example .env        # fill in STRIPE_SECRET_KEY (test mode), ANTHROPIC_API_KEY, DEEPGRAM_API_KEY
npm i
npm run seed                # READ-ONLY sync from Stripe -> data/menu.json (safe to re-run)

# terminal 1 — forward webhooks; copy the printed whsec_... into .env as STRIPE_WEBHOOK_SECRET
npm run stripe:listen

# terminal 2
npm run dev                 # server :3000 + kiosk UI :5173
```

**Menu = Stripe catalog.** `npm run seed` never creates, updates or deletes anything in Stripe. It lists every
*active* Product that has `metadata.menu_id` and rewrites `data/menu.json`: name, currency, category (from
`metadata.category`) and one **size variant per active one-time Price** (`size` from the price's `metadata.size` or
lookup_key suffix, `label` from its nickname, e.g. `Pepperoni (Large 14")` → `Large 14"`, plus `price_cents` and
`price_id`). One variant is the default, used when the customer doesn't say a size: the product's `default_price` if
set, else the middle of three (pizzas → Medium), else the cheapest (drinks → can, wings → 6). Products without
`metadata.menu_id` are ignored; menu items with no active Stripe product are dropped. Speech aliases in
`data/menu.json` are kept across syncs; edit them there if you need to.

To add a menu item: create the Product in the Stripe Dashboard (test mode) with metadata `menu_id` (e.g.
`garlic_knots`) and `category` (`pizza`, `side`, `drink`, ...), and give it one one-time Price per size (Price
metadata `size`, e.g. `small`/`medium`/`large`, and a nickname like `Garlic knots (6 knots)`), then re-run `npm run seed` and restart the server. All prices must share one currency.

Open http://localhost:5173. Tap **Start** and talk, or type into the box (typed text is treated exactly like a final
speech chunk, so the whole flow works without a mic or Deepgram key). Pay with test card `4242 4242 4242 4242`.

Notes
- No `DEEPGRAM_API_KEY` → server still boots, mic is ignored, typed orders work.
- No `STRIPE_WEBHOOK_SECRET` → payment is still detected by the 2 s Checkout poller.
- `PUBLIC_URL` is the Checkout `success_url` base (`/paid.html`). For a real phone, set it to a URL the phone can reach
  (LAN IP with `vite --host`, or a tunnel).
- `CART_MODEL` defaults to `claude-haiku-5-5`.

Scripts: `dev`, `seed`, `typecheck`, `stripe:listen`.

## Architecture

```
 ┌──────────── Kiosk (Vite, web/) ─────────────┐
 │ MediaRecorder webm/opus (250ms chunks) ─┐   │
 │ text box / Done / Reset ───────────────┐│   │
 │ transcript · cart · notices · QR ◄──┐  ││   │
 └─────────────────────────────────────┼──┼┼───┘
                    /ws (Vite proxy)    │  ││
 ┌──────────── Server (Express + ws, server/) ───────────────────────┐
 │ index.ts  WS hub, one OrderSession + Stt per connection           │
 │   binary ──► stt.ts ──raw WS──► Deepgram nova-3 (interim, keyterms)│
 │                 │ final                                           │
 │   {text} ───────┴──► order.ts  transcript[] ─► agent.ts ─► Claude │
 │                       │  (serialised, 1 in-flight + 1 rerun)      │
 │                       │  cart priced from data/menu.json          │
 │                       ├─ order_complete / {done}                  │
 │                       ▼                                           │
 │                  stripe.ts  checkout.sessions.create ─► {checkout}│
 │   POST /webhook ◄── Stripe (checkout.session.completed) ─┐        │
 │   poller (2s, checkout.sessions.retrieve) ───────────────┴► {paid}│
 └───────────────────────────────────────────────────────────────────┘
```

**Full-cart reconcile:** each agent call gets the menu + the *entire* order transcript and returns the *entire* cart
(structured output via `messages.parse` + Zod). No incremental patching, so corrections are just re-reasoning. The
server then validates: drops unknown `menu_id`s, drops items whose quote isn't in the transcript, merges duplicates,
moves qty > 10 to confirmation, and only honours `order_complete` if the cart is non-empty and no newer speech is
still waiting.

## WebSocket contract (`/ws`)

| Direction | Message |
|---|---|
| kiosk → server | binary audio chunk (webm/opus from MediaRecorder; a chunk starting with the EBML header starts a new Deepgram stream) |
| kiosk → server | `{type:"text", text}` — treated exactly like a final transcript chunk |
| kiosk → server | `{type:"done"}` — checkout now (if cart non-empty) |
| kiosk → server | `{type:"reset"}` — new order |
| server → kiosk | `{type:"transcript", text, final}` |
| server → kiosk | `{type:"cart", items:[{menu_id,name,qty,size,size_label,defaulted,price_id,unit_price_cents,line_total_cents,quote}], total_cents, currency}` |
| server → kiosk | `{type:"notice", text}` — unrecognised items / confirmation questions / info |
| server → kiosk | `{type:"checkout", url}` |
| server → kiosk | `{type:"paid"}` |
| server → kiosk | `{type:"error", text}` |

HTTP: `GET /api/health`, `GET /api/menu`, `POST /webhook` (Stripe, raw body + signature check).

## Cart agent policy

- **§1 Menu only.** Only items in `data/menu.json`. Anything else → `unrecognised` (shown as a notice), never added.
- **§2 Evidence.** Every cart line cites the exact transcript quote that justified it (shown under the line, and
  summarised into Checkout metadata). Lines without a verifiable quote are dropped server-side.
- **§3 Quantity sanity.** More than 10 of one item → `needs_confirmation`, not the cart.
- **§4 Completion.** `order_complete` only when the customer clearly signals the end *and* the cart is non-empty.
- **§5 Sizes.** The model returns the size the customer said (or `null`); the server validates it against the item's
  variants, falls back to the default (shown as "(default)" in the cart, with a notice if the size was invalid), and
  keeps different sizes of one item as separate lines.
- **§6 No prices from the model.** Prices and totals come from the menu (display) and Stripe Prices (charge).

## Files

```
data/menu.json        menu synced from Stripe (id, name, aliases, currency, category, variants[size,label,price_cents,price_id,default])
server/index.ts       Express + WS hub, webhook
server/order.ts       per-connection session: transcript, cart, status, agent serialisation, poller
server/agent.ts       Claude cart reconcile + server-side policy validation
server/stt.ts         Deepgram live STT (raw WebSocket)
server/stripe.ts      Stripe client, Checkout creation, webhook verification
server/seed.ts        read-only Stripe catalog -> menu.json sync
web/                  kiosk UI (index.html, main.ts, style.css) + paid.html
```
