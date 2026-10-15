// The written policy the agent works inside. Keep in sync with AGENTS.md "Guardrails".
export const POLICY = [
  { id: 'R1', short: 'On the menu', text: 'Only items and sizes on Rocco\'s menu can be ordered. Anything else gets a polite no and a suggestion.' },
  { id: 'R2', short: 'Menu price', text: 'Prices come from the menu in Stripe, never from the AI. No discounts outside meal deals. Build your own is a Margherita at that size plus the menu\'s extra-topping price per topping.' },
  { id: 'R3', short: 'Choices made', text: 'Wings need a sauce and ice cream needs a flavour before checkout. Gluten-free base is small only.' },
  { id: 'R4', short: 'Staff approval', text: 'More than 10 pizzas in one order needs a member of staff to approve it.' },
  { id: 'R5', short: 'Allergens', text: 'Allergen answers come from the menu only, always with the kitchen allergen notice.' },
  { id: 'R6', short: 'Read back', text: 'The order is read back and confirmed before the payment code appears.' },
  { id: 'R7', short: 'Recorded', text: 'Every change keeps the customer\'s words and the rule that allowed it.' },
]

export const POLICY_BY_ID = Object.fromEntries(POLICY.map((rule) => [rule.id, rule]))

export const PIZZA_LIMIT = 10
