# Demo video script

Two minutes, hard stop. Judges stop watching at 2:00. Record at 20:30.

The moment to land: **the customer asks for something we don't sell, and the cashier says no.** That is the agent working inside its rules (R1, "On the menu") with nobody stepping in. Everything else in the video is setup and payoff for that.

## Setup

- Order screen open full screen: `/?live` with the server running (`npm run dev`), or demo mode (`npm run dev:web`) as the fallback.
- Headset mic on. If the room is too loud, type the same lines into the order box instead. The server handles typed lines the same way as speech.
- Phone ready with the camera open, to scan the QR code.
- Card: `4242 4242 4242 4242`, any future date, any CVC.

## The script

| Time | Customer says | What happens on screen |
|---|---|---|
| 0:00 | *(voiceover)* "This is Rocco's, a pizza takeaway. There's no cashier. You just talk." | Menu board, empty ticket. |
| 0:10 | "Hi, can I get a large pepperoni with stuffed crust please" | Pepperoni lights up and lands on the ticket with the quote. |
| 0:18 | "and a medium margherita, no basil oil" | Margherita added. |
| 0:25 | "actually make the margherita a large" | The line changes in place. Edits by voice. |
| 0:33 | **"can I get a calzone as well?"** | **Polite no: "Sorry, calzones aren't on our menu." Nothing is added to the ticket.** |
| 0:45 | *(voiceover)* "It only sells what's on the menu, at menu prices. That's the written policy, and it enforces it." | Point at the rule shown on screen. |
| 0:52 | "go on then, twelve chicken wings" | Wings added. Rocco's asks which sauce. |
| 0:58 | "buffalo please" | Sauce set. |
| 1:03 | "a bottle of Coke too" … "actually drop the Coke, make it a Diet Coke" | Coke struck through, Diet Coke added. |
| 1:12 | "that's everything" | Order read back. |
| 1:20 | "yep, that's right" | Ticket flips to the QR code. |
| 1:25 | *(scan with phone, pay with 4242)* | Real Stripe Checkout page in test mode. |
| 1:45 | | Screen flips to **PAID**. |
| 1:50 | *(voiceover)* "Every line on that bill shows what the customer said and the rule that allowed it." | Ticket with quotes and rule IDs. |
| 2:00 | End. | |

Demo mode also has a garlic and herb dip and a cookie dough between the wings and "that's everything". Say them if there's time; they add about 10 seconds.

## The off-menu moment

- **Say it clearly and pause after it.** The "no" is the point. Give the toast a second on screen before moving on.
- **Backup line** if calzone doesn't trigger a refusal: "and a chocolate milkshake?" (no milkshakes on the menu).
- In live mode the refusal shows as a toast from the server (`server/order.ts`). In demo mode it's step 4 of `web/src/demoScript.js` and also offers a suggestion.

## If something breaks while recording

- Voice not picking up: type the lines instead.
- Live server down: switch to demo mode. Press A to autoplay, or → to step, then P to mark it paid.
- Over 2:00: cut the Coke swap first, then the wings sauce.
