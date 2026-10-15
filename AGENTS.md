# Rocco's Pizza voice cashier: hackathon context

Read this first. It is the shared brief for anyone (human or agent) working in this repo, so nobody has to re-explain the project.

## What we're building

A voice cashier for a local UK pizza takeaway. The customer speaks their order at the counter; we transcribe it live, turn it into a structured order on screen as they talk, let them change it by voice ("actually make that a large", "no onions", "drop the Coke"), then show a QR code that opens a Stripe Checkout page to pay.

## The event

- **Briefcase × Stripe Hackathon, London**, Thursday 15 October 2026. Details: https://hackathons.briefcase.so/stripe-october-2026/
- **Track 02: Agents that collect.** A real-world trigger (the customer's conversation) makes the agent create a real bill in Stripe test mode, with no human raising the bill.
- **Timeline:** hacking 18:00–21:00 · pizza 19:00 · **record the demo video at 20:30** · submissions close 21:00 · finalists announced 21:25 · finalist demos (3 min, in person) 21:35.
- **Submission:** a **public** GitHub repo plus a demo video of **2 minutes or less** (Loom, unlisted YouTube or a viewable Drive link). Judges stop watching at 2:00. One submission per team, editable until 21:00.
- **Rules:** Stripe test mode only, on our own account. Commits made before 18:00 are shown to judges.
- **This repo is private and must be made public before submitting.**

## How we're judged (and what each criterion needs from us)

| Points | Criterion | What we need to show |
|---|---|---|
| 35 | Works end to end | A real Checkout Session created in test mode, paid with card `4242 4242 4242 4242` in the video, and the screen flipping to "Paid". |
| 25 | Autonomy with control | The agent takes the whole order with no human, inside an explicit written policy it visibly enforces (see Guardrails). |
| 20 | Explains every pound | An audit trail: every line on the bill links back to what the customer said and which rule allowed it. |
| 20 | Product and creativity | Would a real takeaway use it? Fast, clear, handles edits naturally. |

Optional side quest: best use of Cognee memory (e.g. a returning customer saying "the usual"). Only if the core flow is finished.

## Who does what

- **Alex** (not an engineer): frontend interface, Stripe setup, menu, demo video. Explain things in plain English.
- **Che** (engineer): live transcription, turning speech into order changes, voice edits, sending the order through to checkout.

## The flow

1. Mic in the browser streams audio to transcription.
2. Each new utterance goes to an LLM with the menu and the current order; it returns a change to the order (add, remove, change size, change quantity, add or remove a topping, add a note) plus the quote it came from.
3. The server checks the change against the menu and guardrails, applies it, and pushes the new order to the screen.
4. When the customer says they're done, the agent reads the order back and the customer confirms.
5. The server creates a Stripe Checkout Session from the order and the screen shows its URL as a QR code.
6. The screen checks the session status every couple of seconds and shows "Paid" once it completes. Polling is fine here; webhooks need the Stripe CLI, which isn't set up.

## Stripe

- **Use the hackathon Stripe sandbox only.** Never Briefcase Tech Ltd's Stripe account, and never the Stripe MCP connector in Alex's Briefcase sessions (it is signed in to that account).
- The sandbox secret key lives in `.env` as `STRIPE_SECRET_KEY` (gitignored; template in `.env.example`). The seed script refuses any key that isn't `sk_test_` or `rk_test_`.
- The sandbox also has two unrelated products, "Base" and "Plus", from before the hackathon. Ignore them.

## The menu

- **Source of truth:** `scripts/menuData.mjs`. Rocco's Pizza: 11 pizzas (small 10" / medium 12" / large 14"), size-priced pizza extras (extra topping, stuffed crust, gluten-free base), 10 sides, 4 dips, 6 drinks (can or 1.5L bottle), 3 desserts and 3 meal deals. 40 items, 72 prices, GBP.
- **Push it to Stripe:** `node scripts/seedMenu.mjs`. It creates what's missing, updates what changed, archives what was removed, and is safe to rerun. `--dry-run` prints the menu without touching Stripe.
- **Output:** `menu.json`, which is every item with its Stripe product ID and price IDs, plus toppings, allergens (UK 14), dietary tags, chilli level, popular flags, required options (wing sauce, ice cream flavour) and meal deal contents. The app reads this file. Allergen lists are plausible guesses for the demo, not verified recipes.
- Each price has a lookup key `<item id>_<size>`, e.g. `pepperoni_large`, `coca_cola_can`, `garlic_bread_regular`.

## Guardrails (the written policy the agent enforces)

These are the proposal; keep this list in sync with what the code actually does, because it's what we show judges.

These are what the code enforces now (server-side, whatever the AI says), unless marked "not built yet".

- Only items and sizes in `menu.json` can be ordered. Anything else is never added; the kiosk says "we don't do that" and suggests one real menu item.
- Out-of-stock items (listed in `data/out-of-stock.json`, currently Rocco's Nduja & Hot Honey) are never added; the kiosk says so and suggests something similar.
- Every line needs the customer's own words as evidence; a line the AI can't quote from the transcript is dropped.
- If a size isn't said, the kiosk asks ("Medium or large on the pepperoni?") but adds the default size meanwhile, marked "(default)", so the order never gets stuck.
- Prices always come from `menu.json` / Stripe, never from the LLM. The AI is never allowed to say a price or total out loud; the server checks every spoken line and only the server reads out the total. No discounts.
- At most one upsell per order, and only once there's a pizza in the order. It is only added if the customer says yes.
- More than 10 of one item is held back for staff to confirm.
- The order is read back by the server (items, sizes and the total from the menu) and the customer must say yes before the QR code appears. Changing anything sends it back to ordering.
- Not built yet: required options (wing sauce, ice cream flavour), gluten-free small only, allergen answers.
- Every change records the quote that caused it and the rule that allowed it. That record is the audit trail on screen.

## Kiosk ↔ server messages (WebSocket `/ws`)

Full table in `README.md`. The voice ones Alex may want to render:

- server → kiosk `{type:"say", text, audio_url}`: the kiosk is talking. Show `text` (currently a "kiosk says" line at the top of the left panel, added by `web/voice.ts`); `voice.ts` plays the audio.
- server → kiosk `{type:"stop_speaking"}`: the customer talked over the kiosk; stop the audio.
- server → kiosk `{type:"status", status}`: `ordering`, `awaiting_confirmation` (order read back, waiting for "yes"), `awaiting_payment` (QR showing) or `paid`.
- kiosk → server `{type:"speaking", on}`: sent by `voice.ts` when audio starts and stops.
- kiosk → server `{type:"done"}`: the Done button. First press reads the order back; pressing again while it's waiting for "yes" skips to the QR. `{type:"checkout_now"}` skips straight to the QR (testing).
- Barge-in (talking over the kiosk) is on by default, for a headset. Open the kiosk with `?bargein=0` when using speakers, so it doesn't hear itself.

The voice is Deepgram Aura-2 `aura-2-draco-en` (British, warm), set by `TTS_MODEL` in `.env`.

## Known gotchas

- Stripe Checkout shows only the product name, not the price's size, so a small and a large Pepperoni would both read "Pepperoni". For clear receipts, build each line with `price_data` (`product_data.name` such as "Large Pepperoni, stuffed crust") and take `unit_amount` from `menu.json`, or accept the plain names.
- The event room will be noisy. Use a headset mic for the demo, and keep a typed or pre-recorded input as a fallback.

## Still to decide

- The exact order JSON shape shared between Che's backend and Alex's screen (proposed per line: item id, size, quantity, toppings added or removed, options, notes, source quote).
- Frontend stack, transcription provider and LLM.
- Whether to try the Cognee side quest.

## Repo conventions

- Commit straight to `main` and push. Commit messages are lower case, short and clear, e.g. `add stripe menu seed and rocco's pizza menu`. No AI attribution lines in commits.
- Never commit `.env` or any key.
- Keep this file current: when a decision is made or something is built, update the relevant section so the next conversation starts with the full picture.

## Status

- [x] Repo created (Che)
- [x] Stripe sandbox set up, menu seeded, test checkout priced correctly (£52.45 sample order)
- [ ] Order JSON shape agreed
- [x] Transcription → order changes (Che)
- [x] Kiosk talks back (Deepgram Aura-2 voice): asks sizes, says not on menu / out of stock, one upsell, reads the order back and waits for "yes" (Che)
- [ ] Order screen + QR + paid state (Alex)
- [x] Checkout Session creation from an order
- [ ] Guardrails and audit trail visible on screen
- [ ] Repo made public
- [ ] Demo video recorded and submitted by 21:00
