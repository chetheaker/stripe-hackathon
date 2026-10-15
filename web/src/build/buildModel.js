import { formatPrice, priceFor } from '../menu'

/*
  Build your own. The customer talks a pizza into existence: size and base,
  sauce, cheese, then toppings fly on. It's priced from the menu, never made
  up: a Margherita at that size (it already includes sauce and cheese), plus
  the menu's extra-topping price for each topping, plus stuffed crust or a
  gluten-free base if chosen. Every choice keeps the quote and rule that
  allowed it, and all of that becomes the line's audit trail on the ticket.

  Events (they go through the same order reducer as everything else):
  { type: 'build_open', quote }
  { type: 'build', size?, crust?, sauce?, cheese?, add?: [toppingId], remove?: [toppingId], quote }
  { type: 'build_bake', quote }   into the oven
  { type: 'build_done' }          out of the oven and onto the ticket
  { type: 'build_cancel' }
*/

export const BASE_ITEM = 'margherita'
export const MAX_TOPPINGS = 8

export const SIZES = [
  { id: 'small', label: 'Small', detail: '10"', radius: 1.0, words: ['small', 'ten inch', '10 inch'] },
  { id: 'medium', label: 'Medium', detail: '12"', radius: 1.18, words: ['medium', 'twelve inch', '12 inch', 'regular size'] },
  { id: 'large', label: 'Large', detail: '14"', radius: 1.36, words: ['large', 'fourteen inch', '14 inch', 'big one'] },
]

export const CRUSTS = [
  { id: 'classic', label: 'Classic', words: ['classic', 'normal crust', 'regular crust', 'normal base', 'thin'] },
  { id: 'stuffed', label: 'Stuffed crust', extra: 'stuffed_crust', words: ['stuffed'] },
  { id: 'gluten_free', label: 'Gluten-free', extra: 'gluten_free_base', words: ['gluten free', 'gluten-free', 'gluten'] },
]

export const SAUCES = [
  { id: 'tomato', label: 'Tomato', words: ['tomato', 'marinara', 'red sauce'] },
  { id: 'bbq', label: 'BBQ', words: ['bbq', 'barbecue', 'barbeque', 'b b q'] },
  { id: 'garlic', label: 'Garlic & herb', words: ['garlic', 'white sauce'] },
]

export const CHEESES = [
  { id: 'mozzarella', label: 'Mozzarella', words: ['mozzarella', 'mozz', 'normal cheese', 'cheese please', 'extra cheese'] },
  { id: 'vegan', label: 'Vegan mozzarella', words: ['vegan'] },
  { id: 'none', label: 'No cheese', words: ['no cheese', 'without cheese', 'hold the cheese'] },
]

export const TOPPINGS = [
  { id: 'pepperoni', label: 'Pepperoni', words: ['pepperoni', 'peperoni', 'salami'] },
  { id: 'mushrooms', label: 'Mushrooms', words: ['mushroom'] },
  { id: 'green_peppers', label: 'Green peppers', words: ['green pepper', 'peppers', 'pepper'] },
  { id: 'red_onion', label: 'Red onion', words: ['onion'] },
  { id: 'black_olives', label: 'Black olives', words: ['olive'] },
  { id: 'sweetcorn', label: 'Sweetcorn', words: ['sweetcorn', 'sweet corn', 'corn'] },
  { id: 'pineapple', label: 'Pineapple', words: ['pineapple'] },
  { id: 'ham', label: 'Ham', words: ['ham'] },
  { id: 'roast_chicken', label: 'Roast chicken', words: ['chicken'] },
  { id: 'spicy_beef', label: 'Spicy beef', words: ['beef', 'mince'] },
  { id: 'jalapenos', label: 'Jalapeños', words: ['jalapeño', 'jalapeno', 'halapeno', 'jalepeno', 'jalapenio'] },
  { id: 'nduja', label: 'Nduja', words: ['nduja', 'n duja', 'njuda', 'en duja'] },
  { id: 'basil', label: 'Fresh basil', words: ['basil'] },
  { id: 'rocket', label: 'Rocket', words: ['rocket', 'arugula'] },
]

export const TOPPINGS_BY_ID = Object.fromEntries(TOPPINGS.map((topping) => [topping.id, topping]))
const byId = (list) => Object.fromEntries(list.map((entry) => [entry.id, entry]))
export const SIZES_BY_ID = byId(SIZES)
export const CRUSTS_BY_ID = byId(CRUSTS)
export const SAUCES_BY_ID = byId(SAUCES)
export const CHEESES_BY_ID = byId(CHEESES)

// Things people ask for that Rocco's doesn't do on build-your-own.
const OFF_MENU = ['anchovies', 'anchovy', 'tuna', 'prawn', 'shrimp', 'egg', 'chocolate', 'banana', 'bacon', 'goat', 'feta', 'truffle', 'kebab', 'chips', 'avocado', 'sardine', 'crab', 'lobster', 'caviar', 'gold leaf', 'marshmallow']

export const STEPS = [
  { id: 'base', title: 'Size & base', hint: '“A large, stuffed crust”' },
  { id: 'sauce', title: 'Sauce', hint: '“Tomato sauce” · “BBQ” · “Garlic & herb”' },
  { id: 'cheese', title: 'Cheese', hint: '“Mozzarella” · “Vegan cheese” · “No cheese”' },
  { id: 'toppings', title: 'Toppings', hint: '“Pepperoni, mushrooms and jalapeños”' },
  { id: 'bake', title: 'Bake', hint: '“That’s it, bake it!”' },
]

export const initialBuild = () => ({
  size: null,
  crust: 'classic',
  sauce: null,
  cheese: null,
  toppings: [],
  stage: 'building', // building → baking → done
  history: [],
  lastChange: null,
})

export const currentStep = (build) => {
  if (!build.size) return 'base'
  if (!build.sauce) return 'sauce'
  if (!build.cheese) return 'cheese'
  if (build.stage !== 'building') return 'bake'
  return 'toppings'
}

const toppingPrice = (size) => priceFor('extra_topping', size ?? 'medium').unitAmount

// Itemised from menu prices: base, crust, then each topping.
export const buildPricing = (build) => {
  const size = build.size ?? 'medium'
  const parts = [{ id: 'base', label: `${SIZES_BY_ID[size].label} base, sauce & cheese`, unitAmount: priceFor(BASE_ITEM, size).unitAmount }]
  const crust = CRUSTS_BY_ID[build.crust]
  if (crust.extra) parts.push({ id: crust.id, label: crust.label, unitAmount: priceFor(crust.extra, size).unitAmount })
  for (const id of build.toppings) parts.push({ id, label: TOPPINGS_BY_ID[id].label, unitAmount: toppingPrice(size) })
  return { parts, total: parts.reduce((sum, part) => sum + part.unitAmount, 0) }
}

const fail = (rule, reason, suggestion) => ({ ok: false, rule, reason, suggestion })

// Applies one 'build' event. Returns { ok, build, change, rules } or a failure.
export const applyBuild = (build, event) => {
  const next = { ...build, toppings: [...build.toppings] }
  const changes = []
  const rules = new Set(['R1', 'R2'])

  if (event.size) {
    if (!SIZES_BY_ID[event.size]) return fail('R1', 'We don\'t do that size', 'Small, medium or large')
    if (next.crust === 'gluten_free' && event.size !== 'small') {
      return fail('R3', 'Gluten-free base only comes in small', 'Keep it small, or switch to a classic base')
    }
    next.size = event.size
    changes.push(`${SIZES_BY_ID[event.size].label} ${SIZES_BY_ID[event.size].detail} base`)
  }
  if (event.crust) {
    if (event.crust === 'gluten_free' && (next.size ?? 'small') !== 'small') {
      return fail('R3', 'Gluten-free base only comes in small', 'Make it a small?')
    }
    if (event.crust === 'gluten_free') rules.add('R3')
    next.crust = event.crust
    changes.push(CRUSTS_BY_ID[event.crust].label)
  }
  if (event.sauce) {
    next.sauce = event.sauce
    changes.push(`${SAUCES_BY_ID[event.sauce].label} sauce`)
  }
  if (event.cheese) {
    next.cheese = event.cheese
    changes.push(CHEESES_BY_ID[event.cheese].label)
  }
  for (const id of event.remove ?? []) {
    if (!next.toppings.includes(id)) continue
    next.toppings = next.toppings.filter((topping) => topping !== id)
    changes.push(`− ${TOPPINGS_BY_ID[id].label}`)
    rules.add('R7')
  }
  for (const id of event.add ?? []) {
    if (!TOPPINGS_BY_ID[id]) return fail('R1', 'That topping isn\'t on our menu')
    if (next.toppings.includes(id)) continue
    if (next.toppings.length >= MAX_TOPPINGS) return fail('R1', `Up to ${MAX_TOPPINGS} toppings on build-your-own`, 'Swap one out?')
    next.toppings.push(id)
    changes.push(`+ ${TOPPINGS_BY_ID[id].label} ${formatPrice(toppingPrice(next.size))}`)
  }
  if (changes.length === 0) return { ok: true, build, change: null }
  return { ok: true, build: next, change: changes.join(' · '), rules: [...rules] }
}

// The finished pizza as an order 'add' event.
export const buildToOrderEvent = (build) => ({
  type: 'add',
  item: BASE_ITEM,
  size: build.size,
  extras: CRUSTS_BY_ID[build.crust].extra ? [CRUSTS_BY_ID[build.crust].extra] : [],
  custom: {
    sauce: SAUCES_BY_ID[build.sauce].label,
    cheese: CHEESES_BY_ID[build.cheese].label,
    toppings: build.toppings.map((id) => ({ id, name: TOPPINGS_BY_ID[id].label })),
  },
  history: build.history,
  quote: build.history.at(-1)?.quote ?? null,
})

/* ---------- Speech → build events ---------- */

const OPEN = /\b(build|make|create|design|do)\b.{0,20}\b(my|your|me an?|our) own\b|\bbuild your own\b|\bcustom pizza\b|\bown pizza\b/
const BAKE = /\b(bake it|bake|that'?s it|that is it|that'?s all|done|finished|cook it|in the oven|that'?s everything|looks good)\b/
const CANCEL = /\b(cancel|never ?mind|forget it|go back|scrap (it|that|the pizza))\b/
const NEGATE = /\b(no|not|without|take off|takeoff|remove|drop|hold the|get rid of|lose the|minus|less|scrap)\b/

const has = (text, words) => words.some((word) => new RegExp(`\\b${word}`).test(text))

export const isBuildRequest = (text) => OPEN.test(normalise(text))

const normalise = (text) => text.toLowerCase().replace(/[’]/g, '\'').replace(/[^a-z0-9ñ' -]+/g, ' ').replace(/\s+/g, ' ').trim()

// Turns one utterance into build events. Unknown food words become a polite no.
export const parseBuildUtterance = (raw, build) => {
  const text = normalise(raw)
  const quote = raw.trim()
  if (CANCEL.test(text)) return [{ type: 'build_cancel', quote }]

  const event = { type: 'build', quote }
  const size = SIZES.find((option) => has(text, option.words))
  if (size) event.size = size.id
  const crust = CRUSTS.find((option) => has(text, option.words))
  if (crust) event.crust = crust.id
  const sauce = SAUCES.find((option) => has(text, option.words.map((word) => (word === 'garlic' ? 'garlic(?! (bread|mayo))' : word))))
  if (sauce) event.sauce = sauce.id
  const cheese = CHEESES.find((option) => has(text, option.words))
  if (cheese) event.cheese = cheese.id
  else if (!build.cheese && build.sauce && /\bcheese\b/.test(text)) event.cheese = 'mozzarella'

  // "No onions and olives" removes both; "no mushrooms but add olives" flips back to adding.
  const clauses = text.replace(/\b(but|plus|also|with(?! ?out)|add)\b/g, '| add ').split(/\||,|\band\b|\bactually\b/)
  let negative = false
  for (const clause of clauses) {
    if (NEGATE.test(clause)) negative = true
    else if (/\b(add|put|extra|some)\b/.test(clause)) negative = false
    for (const topping of TOPPINGS) {
      if (topping.id === 'green_peppers' && /\bpepperoni|jalap/.test(clause) && !/\bgreen pepper|\bpeppers\b/.test(clause)) continue
      if (!has(clause, topping.words)) continue
      ;(negative ? (event.remove ??= []) : (event.add ??= [])).push(topping.id)
    }
  }

  const events = []
  const offMenu = OFF_MENU.find((word) => new RegExp(`\\b${word}`).test(text))
  if (offMenu && !event.add?.length) {
    events.push({ type: 'reject', quote, rule: 'R1', reason: `Sorry, ${offMenu} ${/s$/.test(offMenu) ? 'aren\'t' : 'isn\'t'} on our build-your-own menu`, suggestion: 'Nduja or jalapeños are good shouts' })
  }
  if (Object.keys(event).length > 2) events.push(event)
  if (BAKE.test(text) && build.size) events.push({ type: 'build_bake', quote })
  return events
}
