import { applyBuild, buildToOrderEvent, currentStep, initialBuild } from './build/buildModel'
import { ITEMS_BY_ID, liveLines, priceFor, sizeWord } from './menu'
import { PIZZA_LIMIT } from './policy'

/*
  The screen is driven by a stream of order events. The demo script, taps on
  the menu board and (later) Che's live feed all send the same shapes:

  { type: 'utterance', speaker: 'customer' | 'agent', text, final }
  { type: 'add', item, size, quantity, extras, without, options, note, quote }
  { type: 'update', line, size?, quantity?, addExtras?, removeExtras?, without?, options?, note?, quote }
  { type: 'remove', line, quote }
  { type: 'reject', quote, reason, suggestion }
  { type: 'confirm_request' }   agent reads the order back
  { type: 'confirmed', quote }  customer says yes
  { type: 'edit_again' }        customer wants to change something
  { type: 'approve' }           staff approve a big order
  { type: 'notice', text }      anything the customer should see as a toast
  { type: 'checkout_ready', url }
  { type: 'paid' }
  { type: 'reset' }
  build_open / build / build_bake / build_done / build_cancel: see build/buildModel.js

  `line` is a line id ("l3") or an item id ("pepperoni"), which means the
  latest line for that item. `quote` is what the customer said; null means
  they tapped the screen.
*/

export const initialOrder = () => ({
  seq: 0,
  phase: 'ordering',
  lines: [],
  lineCount: 0,
  captions: { live: null, said: [], count: 0 },
  lastEvent: null,
  approved: false,
  checkoutUrl: null,
  build: null,
  orderNo: 400 + Math.floor(Math.random() * 500),
})

const fail = (rule, reason, suggestion) => ({ ok: false, rule, reason, suggestion })

// Checks a line against the menu and policy. Returns the rules that allowed it.
export const checkLine = (line) => {
  const item = ITEMS_BY_ID[line.itemId]
  if (!item || item.category === 'pizza_extra') return fail('R1', 'That isn\'t on our menu')
  if (!priceFor(item.id, line.size)) {
    return fail('R1', `${item.name} doesn't come in that size`, item.prices.map((price) => price.label).join(' or '))
  }
  if (line.quantity < 1 || !Number.isInteger(line.quantity)) return fail('R1', 'That quantity doesn\'t look right')

  const rules = ['R1', 'R2']
  if (line.extras.length > 0) {
    if (item.category !== 'pizza') return fail('R1', 'Extras are for pizzas only')
    if (line.extras.includes('gluten_free_base') && line.size !== 'small') {
      return fail('R3', 'Gluten-free base only comes in small', 'Make it a small?')
    }
    if (line.extras.some((extraId) => !priceFor(extraId, line.size))) return fail('R1', 'That extra isn\'t on our menu')
  }
  for (const [name, choice] of Object.entries(line.options)) {
    const option = item.options?.find((candidate) => candidate.name === name)
    if (!option) return fail('R1', `${item.name} doesn't have a ${name} choice`)
    if (!option.choices.includes(choice)) return fail('R1', `We don't do ${choice} ${name}`, option.choices.join(', '))
    if (option.required) rules.push('R3')
  }
  return { ok: true, rules }
}

export const missingOptions = (line) => {
  const item = ITEMS_BY_ID[line.itemId]
  return (item.options ?? []).filter((option) => option.required && !line.options[option.name])
}

export const pizzaCount = (lines) => liveLines(lines)
  .filter((line) => ITEMS_BY_ID[line.itemId].category === 'pizza')
  .reduce((sum, line) => sum + line.quantity, 0)

// Reasons the order can't go to payment yet.
export const blockers = (order) => {
  const live = liveLines(order.lines)
  const reasons = []
  if (live.length === 0) reasons.push({ rule: 'R1', text: 'Nothing ordered yet' })
  for (const line of live) {
    for (const option of missingOptions(line)) {
      reasons.push({ rule: 'R3', text: `${ITEMS_BY_ID[line.itemId].name} needs a ${option.name}`, lineId: line.id })
    }
  }
  if (pizzaCount(order.lines) > PIZZA_LIMIT && !order.approved) {
    reasons.push({ rule: 'R4', text: `More than ${PIZZA_LIMIT} pizzas needs staff approval`, approval: true })
  }
  return reasons
}

const findLine = (lines, ref) => {
  const live = liveLines(lines)
  return live.find((line) => line.id === ref) ?? live.findLast((line) => line.itemId === ref)
}

const describeUpdate = (before, after) => {
  const changes = []
  if (after.size !== before.size) {
    changes.push(`${sizeWord(before.itemId, before.size)} → ${sizeWord(after.itemId, after.size)}`)
  }
  if (after.quantity !== before.quantity) changes.push(`Qty ${before.quantity} → ${after.quantity}`)
  after.extras.filter((id) => !before.extras.includes(id)).forEach((id) => changes.push(`+ ${ITEMS_BY_ID[id].name}`))
  before.extras.filter((id) => !after.extras.includes(id)).forEach((id) => changes.push(`− ${ITEMS_BY_ID[id].name}`))
  after.without.filter((topping) => !before.without.includes(topping)).forEach((topping) => changes.push(`No ${topping}`))
  for (const [name, choice] of Object.entries(after.options)) {
    if (before.options[name] !== choice) changes.push(`${name[0].toUpperCase()}${name.slice(1)}: ${choice}`)
  }
  if (after.note !== before.note) changes.push(`Note: ${after.note}`)
  return changes.join(' · ') || 'No change'
}

const reject = (state, event, check) => ({
  ...state,
  captions: tagLastCustomerLine(state.captions, 'blocked'),
  lastEvent: { type: 'reject', seq: state.seq, quote: event.quote, rule: check.rule, reason: check.reason, suggestion: check.suggestion },
})

const tagLastCustomerLine = (captions, tag) => {
  const index = captions.said.findLastIndex((line) => line.speaker === 'customer')
  if (index === -1) return captions
  return { ...captions, said: captions.said.map((line, i) => (i === index ? { ...line, tag } : line)) }
}

// Any change to the items sends the customer back to ordering.
const backToOrdering = (phase) => (phase === 'confirming' ? 'ordering' : phase)

const editable = (phase) => phase === 'ordering' || phase === 'confirming'

export const orderReducer = (previous, event) => {
  const state = { ...previous, seq: previous.seq + 1 }

  switch (event.type) {
    case 'utterance': {
      const { captions } = state
      const id = captions.live?.id ?? captions.count + 1
      const line = { id, speaker: event.speaker ?? 'customer', text: event.text }
      if (!event.final) return { ...state, captions: { ...captions, live: line, count: Math.max(captions.count, id) } }
      return { ...state, captions: { said: [...captions.said, line].slice(-8), live: null, count: Math.max(captions.count, id) } }
    }

    case 'add': {
      if (!editable(state.phase)) return previous
      const line = {
        id: `l${state.lineCount + 1}`,
        itemId: event.item,
        size: event.size ?? (ITEMS_BY_ID[event.item] ? ITEMS_BY_ID[event.item].prices[0].size : null),
        quantity: event.quantity ?? 1,
        extras: event.extras ?? [],
        without: event.without ?? [],
        options: event.options ?? {},
        note: event.note ?? null,
        custom: event.custom ?? null,
        removed: false,
        history: [],
      }
      const check = checkLine(line)
      if (!check.ok) return reject(state, event, check)
      line.history = event.history ?? [{ quote: event.quote ?? null, change: 'Added', rules: check.rules, seq: state.seq }]
      return {
        ...state,
        phase: backToOrdering(state.phase),
        lines: [...state.lines, line],
        lineCount: state.lineCount + 1,
        lastEvent: { type: 'add', seq: state.seq, lineId: line.id, itemId: line.custom ? 'build_your_own' : line.itemId },
      }
    }

    case 'update': {
      if (!editable(state.phase)) return previous
      const before = findLine(state.lines, event.line)
      if (!before) return reject(state, event, fail('R1', 'Couldn\'t find that on the order'))
      const after = {
        ...before,
        size: event.size ?? before.size,
        quantity: event.quantity ?? before.quantity,
        extras: [...before.extras.filter((id) => !event.removeExtras?.includes(id)), ...(event.addExtras ?? []).filter((id) => !before.extras.includes(id))],
        without: [...before.without, ...(event.without ?? []).filter((topping) => !before.without.includes(topping))],
        options: { ...before.options, ...event.options },
        note: event.note ?? before.note,
      }
      const check = checkLine(after)
      if (!check.ok) return reject(state, event, check)
      after.history = [...before.history, { quote: event.quote ?? null, change: describeUpdate(before, after), rules: check.rules, seq: state.seq }]
      return {
        ...state,
        phase: backToOrdering(state.phase),
        lines: state.lines.map((line) => (line.id === before.id ? after : line)),
        lastEvent: { type: 'update', seq: state.seq, lineId: after.id, itemId: after.itemId },
      }
    }

    case 'remove': {
      if (!editable(state.phase)) return previous
      const target = findLine(state.lines, event.line)
      if (!target) return reject(state, event, fail('R1', 'Couldn\'t find that on the order'))
      const removed = {
        ...target,
        removed: true,
        history: [...target.history, { quote: event.quote ?? null, change: 'Removed', rules: ['R7'], seq: state.seq }],
      }
      return {
        ...state,
        phase: backToOrdering(state.phase),
        lines: state.lines.map((line) => (line.id === target.id ? removed : line)),
        lastEvent: { type: 'remove', seq: state.seq, lineId: target.id, itemId: target.itemId },
      }
    }

    case 'reject':
      return reject(state, event, { rule: event.rule ?? 'R1', reason: event.reason, suggestion: event.suggestion })

    case 'confirm_request': {
      if (state.phase !== 'ordering') return previous
      const reasons = blockers(state)
      if (reasons.length > 0) return { ...state, lastEvent: { type: 'blocked', seq: state.seq, reasons } }
      return { ...state, phase: 'confirming', lastEvent: { type: 'confirm_request', seq: state.seq } }
    }

    case 'confirmed':
      if (state.phase !== 'confirming') return previous
      return { ...state, phase: 'confirmed', lastEvent: { type: 'confirmed', seq: state.seq } }

    case 'edit_again':
      if (state.phase !== 'confirming') return previous
      return { ...state, phase: 'ordering', lastEvent: { type: 'edit_again', seq: state.seq } }

    case 'approve':
      return { ...state, approved: true, lastEvent: { type: 'approve', seq: state.seq } }

    case 'notice':
      return { ...state, lastEvent: { type: 'notice', seq: state.seq, text: event.text } }

    case 'checkout_ready':
      if (!['ordering', 'confirming', 'confirmed'].includes(state.phase)) return previous
      return { ...state, phase: 'checkout', checkoutUrl: event.url, lastEvent: { type: 'checkout_ready', seq: state.seq } }

    case 'paid':
      if (state.phase !== 'checkout') return previous
      return { ...state, phase: 'paid', lastEvent: { type: 'paid', seq: state.seq } }

    case 'build_open': {
      if (!editable(state.phase) || state.build) return previous
      const history = [{ quote: event.quote ?? null, change: 'Started build your own', rules: ['R1', 'R2'], seq: state.seq }]
      return { ...state, phase: backToOrdering(state.phase), build: { ...initialBuild(), history }, lastEvent: { type: 'build_open', seq: state.seq } }
    }

    case 'build': {
      if (!state.build || state.build.stage !== 'building') return previous
      const result = applyBuild(state.build, event)
      if (!result.ok) return reject(state, event, result)
      if (!result.change) return previous
      const entry = { quote: event.quote ?? null, change: result.change, rules: result.rules, seq: state.seq }
      return {
        ...state,
        build: { ...result.build, history: [...state.build.history, entry], lastChange: entry },
        lastEvent: { type: 'build', seq: state.seq },
      }
    }

    case 'build_bake': {
      if (!state.build || state.build.stage !== 'building') return previous
      const step = currentStep(state.build)
      if (step !== 'toppings') {
        return reject(state, event, fail('R3', `Choose your ${step === 'base' ? 'size' : step} first`))
      }
      const entry = { quote: event.quote ?? null, change: 'Into the oven', rules: ['R6'], seq: state.seq }
      return { ...state, build: { ...state.build, stage: 'baking', history: [...state.build.history, entry], lastChange: entry }, lastEvent: { type: 'build_bake', seq: state.seq } }
    }

    case 'build_done': {
      if (!state.build || state.build.stage !== 'baking') return previous
      const added = orderReducer({ ...state, build: null }, buildToOrderEvent(state.build))
      return { ...added, seq: added.seq }
    }

    case 'build_cancel':
      if (!state.build) return previous
      return { ...state, build: null, lastEvent: { type: 'notice', seq: state.seq, text: 'Build your own cancelled' } }

    case 'reset':
      return initialOrder()

    default:
      return previous
  }
}
