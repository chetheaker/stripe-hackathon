import menu from '../../menu.json'

export const RESTAURANT = menu.restaurant
export const ITEMS = menu.items
export const ITEMS_BY_ID = Object.fromEntries(ITEMS.map((item) => [item.id, item]))

export const itemsIn = (category) => ITEMS.filter((item) => item.category === category)

// The order the board is laid out in, and the order we nudge customers through.
export const COURSES = [
  { category: 'pizza', title: 'Pizzas' },
  { category: 'side', title: 'Sides', nudge: 'Anything on the side?' },
  { category: 'dip', title: 'Dips', nudge: 'Any dips with that?' },
  { category: 'drink', title: 'Drinks', nudge: 'Something to drink?' },
  { category: 'dessert', title: 'Desserts', nudge: 'Room for pudding?' },
]

// A meal deal already includes a pizza, a side and a drink.
const DEAL_COVERS = ['pizza', 'side', 'drink']

export const formatPrice = (pence) => `£${(pence / 100).toFixed(2)}`
export const formatShortPrice = (pence) => (pence < 100 ? `${pence}p` : formatPrice(pence))

export const priceFor = (itemId, size) => ITEMS_BY_ID[itemId]?.prices.find((price) => price.size === size)

export const defaultSize = (item) => (item.category === 'pizza' ? 'medium' : item.prices[0].size)

const SIZE_WORDS = { small: 'Small', medium: 'Medium', large: 'Large' }

export const sizeWord = (itemId, size) => {
  if (SIZE_WORDS[size]) return SIZE_WORDS[size]
  return priceFor(itemId, size)?.label ?? size
}

export const lineTitle = (line) => {
  const item = ITEMS_BY_ID[line.itemId]
  const price = priceFor(line.itemId, line.size)
  if (line.custom) return `${SIZE_WORDS[line.size]} Build Your Own`
  if (item.category === 'pizza') return `${SIZE_WORDS[line.size]} ${item.name}`
  if (item.category === 'drink') return `${item.name}, ${price.label.replace('330ml ', '').replace(' bottle', '')}`
  if (line.itemId === 'chicken_wings') return `${price.label.replace(' wings', '')} chicken wings`
  return item.name
}

export const linePricing = (line) => {
  const base = priceFor(line.itemId, line.size)
  const extras = line.extras.map((extraId) => ({
    id: extraId,
    name: ITEMS_BY_ID[extraId].name,
    unitAmount: priceFor(extraId, line.size).unitAmount,
  }))
  // Build-your-own: each topping at the menu's extra-topping price.
  for (const topping of line.custom?.toppings ?? []) {
    extras.push({ id: `topping:${topping.id}`, name: topping.name, unitAmount: priceFor('extra_topping', line.size).unitAmount })
  }
  const unitAmount = base.unitAmount + extras.reduce((sum, extra) => sum + extra.unitAmount, 0)
  return { base, extras, unitAmount, total: line.removed ? 0 : unitAmount * line.quantity }
}

export const orderTotal = (lines) => lines.reduce((sum, line) => sum + linePricing(line).total, 0)

export const liveLines = (lines) => lines.filter((line) => !line.removed)

export const coveredCategories = (lines) => {
  const covered = new Set()
  for (const line of liveLines(lines)) {
    const { category } = ITEMS_BY_ID[line.itemId]
    if (category === 'meal_deal') DEAL_COVERS.forEach((dealCategory) => covered.add(dealCategory))
    else covered.add(category)
  }
  return covered
}

// The next course the customer hasn't touched yet, with one thing to suggest from it.
export const nextNudge = (lines) => {
  if (liveLines(lines).length === 0) return null
  const covered = coveredCategories(lines)
  const course = COURSES.find(({ category }) => !covered.has(category))
  if (!course || course.category === 'pizza') return null
  const options = itemsIn(course.category)
  const item = options.find((option) => option.popular) ?? options[0]
  return { course, item, size: defaultSize(item), unitAmount: priceFor(item.id, defaultSize(item)).unitAmount }
}

// Words worth lighting up in the live captions.
const STOP_WORDS = new Set(['with', 'and', 'the', 'rocco\'s', 'special', 'supreme'])
export const MENU_WORDS = new Set([
  ...ITEMS.filter((item) => item.category !== 'meal_deal')
    .flatMap((item) => item.name.toLowerCase().split(/[\s&,-]+/))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  'small', 'medium', 'large', 'coke', 'wings', 'dip', 'bottle', 'can', 'stuffed', 'crust', 'buffalo', 'bbq',
])
