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
| kiosk → server | `{type:"done"}` — Done button: server reads the order back and asks to confirm; a second press while awaiting confirmation goes straight to checkout |
| kiosk → server | `{type:"checkout_now"}` — testing shortcut: skip the read-back, create the Checkout Session now |
| kiosk → server | `{type:"speaking", on}` — kiosk audio started/stopped (server ignores mic transcripts while speaking unless barge-in is on) |
| kiosk → server | `{type:"reset"}` — new order |
| server → kiosk | `{type:"transcript", text, final}` |
| server → kiosk | `{type:"cart", items:[{menu_id,name,qty,size,size_label,defaulted,price_id,unit_price_cents,line_total_cents,quote}], total_cents, currency}` |
| server → kiosk | `{type:"notice", text}` — unrecognised items / confirmation questions / info |
| server → kiosk | `{type:"checkout", url}` |
| server → kiosk | `{type:"paid"}` |
| server → kiosk | `{type:"error", text}` |
| server → kiosk | `{type:"say", text, audio_url}` — kiosk speaks: show `text`, play `audio_url` (streamed mp3 from `GET /api/tts/:id`) |
| server → kiosk | `{type:"stop_speaking"}` — customer talked over the kiosk (barge-in): stop audio now |
| server → kiosk | `{type:"status", status}` — `"ordering"` \| `"awaiting_confirmation"` \| `"awaiting_payment"` \| `"paid"` |

Connect with `/ws?bargein=0` to turn barge-in off (the kiosk page passes through its own `?bargein=0`). Default is on,
for headset use; off means mic audio isn't sent while the kiosk talks, so it can't hear itself through speakers.

HTTP: `GET /api/health`, `GET /api/menu`, `GET /api/tts/:id` (Deepgram Aura-2 mp3, streamed through; ids are one-minute, server-issued), `POST /webhook` (Stripe, raw body + signature check).

## Cart agent policy

- **§1 Menu only.** Only items in `data/menu.json`. Anything else → `unrecognised` (shown as a notice), never added.
- **§2 Evidence.** Every cart line cites the exact transcript quote that justified it (shown under the line, and
  summarised into Checkout metadata). Lines without a verifiable quote are dropped server-side.
- **§3 Quantity sanity.** More than 10 of one item → `needs_confirmation`, not the cart.
- **§4 Completion.** `order_complete` only when the customer clearly signals the end *and* the cart is non-empty.
- **§5 Sizes.** The model returns the size the customer said (or `null`); the server validates it against the item's
  variants, falls back to the default (shown as "(default)" in the cart, with a notice if the size was invalid), and
  keeps different sizes of one item as separate lines.
- **§6 No prices from the model.** Prices and totals come from the menu (display) and Stripe Prices (charge). The
  spoken reply is checked server-side: any money talk is replaced with "Lovely. Anything else for you?".
- **§7 Out of stock.** `data/out-of-stock.json` (array of menu ids, re-read every call) — those items are never added,
  and the reply says so and suggests something similar.
- **Talking back.** The same agent call returns `reply` (≤ ~15 words, British cashier, one question at a time, or
  null), `upsell_offered` and `confirm`. One upsell per order, server-enforced (and only with a pizza in the cart).
  Speech only happens at end of turn (Deepgram `speech_final` / `UtteranceEnd`, `utterance_end_ms=1000`), using the
  agent result for everything said so far; new speech before then drops the reply.
- **Read-back before QR.** On `order_complete` the server (not the LLM) reads the order back with the total and
  asks "Shall I bring up the payment code?" (`awaiting_confirmation`). "Yes" with an unchanged cart → Checkout;
  "no" or any change → back to `ordering`.
- **Voice.** Deepgram Aura-2 TTS, `TTS_MODEL` (default `aura-2-draco-en`: British, warm, baritone).

## Files

```
data/menu.json        menu synced from Stripe (id, name, aliases, currency, category, variants[size,label,price_cents,price_id,default])
server/index.ts       Express + WS hub, webhook
server/order.ts       per-connection session: transcript, cart, status, agent serialisation, poller
server/agent.ts       Claude cart reconcile + server-side policy validation
server/stt.ts         Deepgram live STT (raw WebSocket, VAD/UtteranceEnd events)
server/tts.ts         Deepgram Aura-2 TTS, GET /api/tts/:id streams mp3 through
data/out-of-stock.json  menu ids that can't be ordered today
web/voice.ts          kiosk audio: play/stop "say", speaking state, mic mute when barge-in is off
server/stripe.ts      Stripe client, Checkout creation, webhook verification
server/seed.ts        read-only Stripe catalog -> menu.json sync
web/                  kiosk UI (index.html, main.ts, style.css) + paid.html
```
