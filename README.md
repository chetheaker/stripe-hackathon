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
 │ voice.ts: AudioWorklet 16k PCM + noise gate┐│
 │ text box / Done / Reset ───────────────┐│   │
 │ transcript · cart · notices · QR ◄──┐  ││   │
 └─────────────────────────────────────┼──┼┼───┘
                    /ws (Vite proxy)    │  ││
 ┌──────────── Server (Express + ws, server/) ───────────────────────┐
 │ index.ts  WS hub, one OrderSession + Stt per connection           │
 │   binary ──► stt.ts ──raw WS──► Deepgram Flux (turn events)       │
 │                 │ final                                           │
 │   {text} ───────┴──► order.ts  transcript[] ─► agent.ts ─► Claude │
 │                       │  (serialised, 1 in-flight + 1 rerun)      │
 │                       │  cart priced from data/menu.json          │
 │   reply.ts (streaming) ─► tts.ts ─► ElevenLabs ─► {say}  · {done} │
 │                       ▼                                           │
 │                  stripe.ts  checkout.sessions.create ─► {checkout}│
 │   POST /webhook ◄── Stripe (checkout.session.completed) ─┐        │
 │   poller (2s, checkout.sessions.retrieve) ───────────────┴► {paid}│
 └───────────────────────────────────────────────────────────────────┘
```

**Full-cart reconcile:** each agent call gets the menu + the *entire* order transcript and returns the *entire* cart
(structured output via `messages.parse` + Zod). No incremental patching, so corrections are just re-reasoning. The
server then validates: drops unknown `menu_id`s, drops items whose quote isn't in the transcript, merges duplicates,
and moves qty > 10 to confirmation. (End of order is decided by the reply call, see Voice loop.)

## WebSocket contract (`/ws`)

| Direction | Message |
|---|---|
| kiosk → server | binary audio: 16 kHz mono linear16 PCM, 80ms chunks (silence below the noise gate, so the stream never stops) |
| kiosk → server | `{type:"text", text}` — a whole typed customer turn (end of turn immediately) |
| kiosk → server | `{type:"hello"}` — Start pressed: server plays the opening greeting (pre-cached audio) |
| kiosk → server | `{type:"playback", id}` — a `say` clip actually started playing (server logs per-turn latency) |
| kiosk → server | `{type:"barge_in"}` — only with `?bargein=1`: customer spoke over the kiosk for ≥400ms; server drops the rest of the reply |
| kiosk → server | `{type:"done"}` — Done button: server reads the order back and asks to confirm; a second press while awaiting confirmation goes straight to checkout |
| kiosk → server | `{type:"checkout_now"}` — testing shortcut: skip the read-back, create the Checkout Session now |
| kiosk → server | `{type:"speaking", on}` — kiosk audio queue started/stopped |
| kiosk → server | `{type:"reset"}` — new order |
| server → kiosk | `{type:"transcript", text, final}` |
| server → kiosk | `{type:"cart", items:[{menu_id,name,qty,size,size_label,defaulted,price_id,unit_price_cents,line_total_cents,quote}], total_cents, currency}` |
| server → kiosk | `{type:"notice", text}` — unrecognised items / confirmation questions / info |
| server → kiosk | `{type:"checkout", url}` |
| server → kiosk | `{type:"paid"}` |
| server → kiosk | `{type:"error", text}` |
| server → kiosk | `{type:"say", text, audio_url, id, turn}` — kiosk speaks: show `text` (sentences of the same `turn` are appended), queue `audio_url` (streamed mp3 from `GET /api/tts/:id`). A reply arrives as one `say` per sentence. |
| server → kiosk | `{type:"stop_speaking"}` — customer talked over the kiosk (barge-in): stop audio now |
| server → kiosk | `{type:"status", status}` — `"ordering"` \| `"awaiting_confirmation"` \| `"awaiting_payment"` \| `"paid"` |

Kiosk URL params (passed through to `/ws`): `?gate=3` noise-gate multiplier over the calibrated room level (raise it
in a loud room, lower it if quiet speech gets cut); `?bargein=1` lets the customer interrupt the kiosk (default off).

HTTP: `GET /api/health`, `GET /api/menu`, `GET /api/tts/:id` (ElevenLabs mp3, streamed while it's generated; ids are two-minute, server-issued), `POST /webhook` (Stripe, raw body + signature check).

## Voice loop (latency + noise)

- **STT / turn detection:** Deepgram **Flux** (`flux-general-en`, `/v2/listen`, linear16 16 kHz, `eot_threshold=0.7`,
  `eager_eot_threshold=0.5`, menu keyterms capped at Flux's 100). `Update` events feed the cart agent live;
  `EagerEndOfTurn` starts the reply speculatively; `TurnResumed` cancels it (Claude stream + TTS aborted, never
  played); `EndOfTurn` releases it.
- **Two Claude calls in parallel:** the cart agent (full reconcile, structured output, all validation) re-runs on
  every transcript update (coalesced, one in flight), so the cart is current by end of turn. The reply agent
  (`server/reply.ts`) is a small streaming Haiku call (compact menu, out-of-stock list, cart, upsell flag, status,
  last few lines; thinking disabled) that outputs ≤15 words; each finished sentence goes straight to ElevenLabs.
- **Fixed text, no LLM:** read-back (server-built with the server total), "Lovely, scan that to pay.", the opening
  greeting and the paid line. The last three are synthesised at server start and play instantly.
- **TTS:** ElevenLabs `eleven_flash_v2_5`, streaming endpoint, `mp3_22050_32`. Voice `ELEVENLABS_VOICE_ID`, default
  George (`JBFqnCBsd6RMkjVDRZzb`, premade: British, middle-aged, warm storyteller). Synthesis starts on the server as
  soon as a sentence exists; the kiosk's `<audio>` queue plays it while it streams.
- **Timing log** per turn: `[turn] eot→reply token · →tts first byte · →sent · →playback`.
- **Noise:** `getUserMedia` with echo cancellation, noise suppression and AGC; a browser noise gate (1.5s room
  calibration at Start, open at ambient × `?gate` (default 3, floor 0.008 RMS) for 150ms, 600ms hang, 300ms pre-roll),
  silence sent below the gate; a level meter + dot next to "Listening…" (orange calibrating, green speech, blue kiosk
  talking). Server drops end-of-turn transcripts that are filler only ("uh", "hmm") or short, low-confidence
  (< 0.6) and contain no meaningful word (yes/no, sizes, numbers, menu words).
- **Echo:** barge-in off by default: the mic is gated while the kiosk speaks and for 300ms after.

## Cart agent policy

- **§1 Menu only.** Only items in `data/menu.json`. Anything else → `unrecognised` (shown as a notice), never added.
- **§2 Evidence.** Every cart line cites the exact transcript quote that justified it (shown under the line, and
  summarised into Checkout metadata). Lines without a verifiable quote are dropped server-side.
- **§3 Quantity sanity.** More than 10 of one item → `needs_confirmation`, not the cart.
- **§4 Completion.** The reply call outputs `DONE` only when the customer clearly signals the end; the server then
  waits for the cart agent to catch up and reads back (an empty cart gets "Your basket's empty").
- **§5 Sizes.** The model returns the size the customer said (or `null`); the server validates it against the item's
  variants, falls back to the default (shown as "(default)" in the cart, with a notice if the size was invalid), and
  keeps different sizes of one item as separate lines.
- **§6 No prices from the model.** Prices and totals come from the menu (display) and Stripe Prices (charge). The
  spoken reply is checked server-side: any money talk is replaced with "Lovely. Anything else for you?".
- **§7 Out of stock.** `data/out-of-stock.json` (array of menu ids, re-read every call) — those items are never added,
  and the reply says so and suggests something similar.
- **Talking back.** A separate streaming reply call (see Voice loop). Server guardrails on every spoken sentence:
  money talk is replaced with "Lovely. Anything else for you?"; at most one upsell per order and only with a pizza in
  the cart (detected from the model's `^` marker *and* offer phrasing, so an unmarked second upsell is dropped).
- **Read-back before QR.** When the customer says they're done (reply call outputs `DONE`, or the Done button) the server (not the LLM) reads the order back with the total and
  asks "Shall I bring up the payment code?" (`awaiting_confirmation`). "Yes" with an unchanged cart → Checkout;
  "no" or any change → back to `ordering`.
- **Voice.** ElevenLabs `eleven_flash_v2_5`, voice `ELEVENLABS_VOICE_ID` (default George).

## Files

```
data/menu.json        menu synced from Stripe (id, name, aliases, currency, category, variants[size,label,price_cents,price_id,default])
server/index.ts       Express + WS hub, webhook
server/order.ts       per-connection session: transcript, cart, status, agent serialisation, poller
server/agent.ts       Claude cart reconcile + server-side policy validation
server/stt.ts         Deepgram Flux live STT (raw WebSocket, turn events)
server/reply.ts       streaming Claude reply (what the kiosk says), sentence-by-sentence
server/tts.ts         ElevenLabs streaming TTS, buffered clips + pre-cached fixed lines, GET /api/tts/:id
data/out-of-stock.json  menu ids that can't be ordered today
web/voice.ts          kiosk audio: AudioWorklet PCM capture, noise gate + meter, playback queue, barge-in
server/stripe.ts      Stripe client, Checkout creation, webhook verification
server/seed.ts        read-only Stripe catalog -> menu.json sync
web/                  kiosk UI (index.html, main.ts, style.css) + paid.html
```
