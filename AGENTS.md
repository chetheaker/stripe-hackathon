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

- Only items and sizes in `menu.json` can be ordered. Anything else gets a polite "we don't do that" and a suggestion.
- Prices always come from `menu.json` / Stripe, never from the LLM. No discounts, ever, unless a meal deal applies.
- Required options must be chosen before checkout (wing sauce, ice cream flavour). Gluten-free base is small only.
- Quantity cap per order (e.g. more than 10 pizzas needs staff approval), as a visible "needs approval" state.
- Allergen questions are answered from `menu.json` only, always with the kitchen allergen notice.
- The order is read back and confirmed before the QR code appears.
- Every change records the quote that caused it and the rule that allowed it. That record is the audit trail on screen.
- Build your own is priced from the menu: a Margherita at that size (includes sauce and cheese), plus the menu's extra-topping price per topping (up to 8), plus stuffed crust or gluten-free base if chosen. Sauce and cheese swaps are free. Only the 14 listed toppings; anything else (anchovies, tuna…) gets a polite no (R1).

## Known gotchas

- Stripe Checkout shows only the product name, not the price's size, so a small and a large Pepperoni would both read "Pepperoni". For clear receipts, build each line with `price_data` (`product_data.name` such as "Large Pepperoni, stuffed crust") and take `unit_amount` from `menu.json`, or accept the plain names.
- The event room will be noisy. Use a headset mic for the demo, and keep a typed or pre-recorded input as a fallback.

## The order screen (`web/`)

- **Stack:** React 18 + Vite (root `vite.config.ts`, root `web`), Motion for list layout, Sonner for toasts, `qrcode.react`. Design and motion follow Emil Kowalski's skills (https://github.com/emilkowalski/skills): custom ease-out curves, transform/opacity only, reduced-motion fallbacks.
- **Run:** `npm run dev:web` and open http://localhost:5173. Che's original plain kiosk is still at http://localhost:5173/basic/.
- **Layout (option A, "menu board that lights up"):** the whole menu is always on screen; items glow and a chip flies to the ticket when mentioned. The ticket on the right shows every line with the customer's quote and the rule ids that allowed it; removed lines stay struck through. The next course they haven't touched (sides, dips, drinks, desserts) is highlighted and offered as a nudge. "That's everything" plays a read-back, then the ticket flips to the QR code, and a PAID stamp lands on payment.
- **Demo mode (default):** a scripted conversation in `web/src/demoScript.js`. Keys: → next step, A autoplay, R reset, P mark paid, H hide demo controls. Without the server the QR is a placeholder link.
- **Live mode:** open `/?live` with Che's server running (`npm run dev`). The screen connects to `/ws`, diffs each `cart` snapshot into add / update / remove animations, shows `transcript` as captions, `notice` as toasts, and reacts to `checkout` and `paid`. Taps on the board send `{type:'text'}`; "Yes, that's right" sends `{type:'done'}`; the mic button streams audio.
- **Order events:** the screen's internal event shapes are documented at the top of `web/src/order.js`. Sizes, extras, "no X" and sauces only show in live mode once the server sends them per cart line (e.g. `size`).
- **Build your own (3D):** saying "can I make my own pizza?" (or tapping the dark "Build your own" card, or pressing B) takes over the screen with a three.js scene (React Three Fiber + drei, all procedural, no model files, no network). The customer talks it into existence: size and crust (the dough ball slaps flat with a flour puff), sauce (spreads in a spiral), cheese (shreds rain down and melt in), toppings (each flies on in an arc and lands with a squash; removed ones fly off), then "bake it" (oven glow, browning crust, embers, steam, ding). It then lands on the ticket as "Large Build Your Own", with every step's quote and rule as its audit trail. Code is in `web/src/build/`: `buildModel.js` (choices, pricing, rules, speech parser), `PizzaScene.jsx` (3D), `BuildMode.jsx` (overlay UI), `sound.js` (synthesised sounds). Rehearse with `/?script=build` (→ to step, A autoplay). In live mode the screen parses final transcripts itself, so it works without server changes, **but Che's server doesn't know about the custom pizza yet**, so a live Checkout Session won't include it until the server accepts a custom line.
- **House rules** (R1–R7) live in `web/src/policy.js` and must match the Guardrails list above.
- **Menu photography:** four generated style-review samples and their prompts are saved in `output/menu-style-review/` (Pepperoni in clean overhead, warm counter and dark studio styles, plus BBQ wings in the clean style). Awaiting Alex's style choice before generating the full menu; samples are not yet wired into the screen.

## Still to decide

- How the server should take a build-your-own pizza into the live cart and Stripe Checkout (e.g. the screen sends the finished pizza as a line with `price_data` built from menu prices), and pause the cart agent while build mode is open so "pepperoni" isn't also added as a Pepperoni pizza.

- Whether Che's cart lines gain `size`, `extras`, `without` and `options` so live mode shows the same detail as the demo.
- Whether to try the Cognee side quest.

## Repo conventions

- Commit straight to `main` and push. Commit messages are lower case, short and clear, e.g. `add stripe menu seed and rocco's pizza menu`. No AI attribution lines in commits.
- Never commit `.env` or any key.
- Keep this file current: when a decision is made or something is built, update the relevant section so the next conversation starts with the full picture.

## Status

- [x] Repo created (Che)
- [x] Stripe sandbox set up, menu seeded, test checkout priced correctly (£52.45 sample order)
- [ ] Order JSON shape agreed
- [ ] Transcription → order changes (Che)
- [x] Build-your-own 3D mode, demo mode working (`/?script=build`); not yet in the live server cart
- [x] Order screen + QR + paid state (Alex), demo mode working; live mode wired to Che's `/ws` but not yet tested against the running server
- [ ] Checkout Session creation from an order
- [x] Guardrails and audit trail visible on screen (demo mode)
- [ ] Repo made public
- [ ] Demo video recorded and submitted by 21:00
