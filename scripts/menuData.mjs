export const RESTAURANT = {
  name: "Rocco's Pizza",
  tagline: 'Stone-baked pizza, sides and shakes since 1998',
  currency: 'gbp',
  allergenNotice:
    'All food is prepared in a kitchen that handles gluten, milk, eggs, mustard, soya, sesame and nuts. Please tell us about any allergies before you order.',
}

const PIZZA_SIZES = (small, medium, large) => [
  { size: 'small', label: 'Small 10"', unitAmount: small },
  { size: 'medium', label: 'Medium 12"', unitAmount: medium },
  { size: 'large', label: 'Large 14"', unitAmount: large },
]

const SINGLE = (unitAmount, label = 'Regular') => [{ size: 'regular', label, unitAmount }]

const DRINK_SIZES = (canAmount, bottleAmount) => [
  { size: 'can', label: '330ml can', unitAmount: canAmount },
  { size: 'bottle', label: '1.5L bottle', unitAmount: bottleAmount },
]

const PIZZA = {
  margherita: {
    name: 'Margherita',
    description: 'Tomato sauce, mozzarella, oregano, basil oil',
    toppings: ['tomato sauce', 'mozzarella', 'oregano', 'basil oil'],
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk'],
    popular: true,
    prices: PIZZA_SIZES(949, 1199, 1399),
  },
  pepperoni: {
    name: 'Pepperoni',
    description: 'Tomato sauce, mozzarella, double pepperoni',
    toppings: ['tomato sauce', 'mozzarella', 'pepperoni'],
    allergens: ['gluten', 'milk'],
    popular: true,
    prices: PIZZA_SIZES(1099, 1349, 1599),
  },
  hawaiian: {
    name: 'Hawaiian',
    description: 'Tomato sauce, mozzarella, ham, pineapple',
    toppings: ['tomato sauce', 'mozzarella', 'ham', 'pineapple'],
    allergens: ['gluten', 'milk'],
    prices: PIZZA_SIZES(1099, 1349, 1599),
  },
  vegetarian_supreme: {
    name: 'Vegetarian Supreme',
    description: 'Tomato sauce, mozzarella, mushrooms, green peppers, red onion, sweetcorn, black olives',
    toppings: ['tomato sauce', 'mozzarella', 'mushrooms', 'green peppers', 'red onion', 'sweetcorn', 'black olives'],
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk'],
    prices: PIZZA_SIZES(1099, 1349, 1599),
  },
  vegan_garden: {
    name: 'Vegan Garden',
    description: 'Tomato sauce, vegan mozzarella, spinach, mushrooms, roasted peppers, red onion, black olives',
    toppings: ['tomato sauce', 'vegan mozzarella', 'spinach', 'mushrooms', 'roasted peppers', 'red onion', 'black olives'],
    dietary: ['vegetarian', 'vegan'],
    allergens: ['gluten'],
    prices: PIZZA_SIZES(1149, 1399, 1649),
  },
  bbq_chicken: {
    name: 'BBQ Chicken',
    description: 'BBQ sauce base, mozzarella, roast chicken, red onion, green peppers, sweetcorn',
    toppings: ['bbq sauce', 'mozzarella', 'roast chicken', 'red onion', 'green peppers', 'sweetcorn'],
    allergens: ['gluten', 'milk', 'mustard', 'celery'],
    popular: true,
    prices: PIZZA_SIZES(1199, 1449, 1699),
  },
  chicken_tikka: {
    name: 'Chicken Tikka',
    description: 'Tomato sauce, mozzarella, tikka chicken, red onion, green peppers, green chillies, mint yoghurt drizzle',
    toppings: ['tomato sauce', 'mozzarella', 'tikka chicken', 'red onion', 'green peppers', 'green chillies', 'mint yoghurt'],
    spiceLevel: 2,
    allergens: ['gluten', 'milk', 'mustard'],
    prices: PIZZA_SIZES(1199, 1449, 1699),
  },
  hot_and_spicy: {
    name: 'Hot & Spicy',
    description: 'Tomato sauce, mozzarella, pepperoni, spicy beef, jalapeños, red onion, green chillies',
    toppings: ['tomato sauce', 'mozzarella', 'pepperoni', 'spicy beef', 'jalapeños', 'red onion', 'green chillies'],
    spiceLevel: 3,
    allergens: ['gluten', 'milk'],
    prices: PIZZA_SIZES(1199, 1449, 1699),
  },
  meat_feast: {
    name: 'Meat Feast',
    description: 'Tomato sauce, mozzarella, pepperoni, ham, spicy beef, Italian sausage, roast chicken',
    toppings: ['tomato sauce', 'mozzarella', 'pepperoni', 'ham', 'spicy beef', 'italian sausage', 'roast chicken'],
    allergens: ['gluten', 'milk'],
    popular: true,
    prices: PIZZA_SIZES(1249, 1499, 1749),
  },
  doner_special: {
    name: 'Doner Special',
    description: 'Tomato sauce, mozzarella, doner meat, red onion, green chillies, garlic mayo drizzle',
    toppings: ['tomato sauce', 'mozzarella', 'doner meat', 'red onion', 'green chillies', 'garlic mayo'],
    spiceLevel: 1,
    allergens: ['gluten', 'milk', 'eggs', 'soya'],
    prices: PIZZA_SIZES(1249, 1499, 1749),
  },
  nduja_hot_honey: {
    name: "Rocco's Nduja & Hot Honey",
    description: 'House special. Tomato sauce, fior di latte, spicy nduja, hot honey, rocket, parmesan',
    toppings: ['tomato sauce', 'fior di latte', 'nduja', 'hot honey', 'rocket', 'parmesan'],
    spiceLevel: 2,
    allergens: ['gluten', 'milk'],
    prices: PIZZA_SIZES(1299, 1549, 1799),
  },
}

const PIZZA_EXTRA = {
  extra_topping: {
    name: 'Extra topping',
    description: 'Any topping from the menu, priced by pizza size',
    appliesTo: 'pizza',
    prices: PIZZA_SIZES(129, 149, 179),
  },
  stuffed_crust: {
    name: 'Stuffed crust',
    description: 'Mozzarella-stuffed crust, priced by pizza size',
    appliesTo: 'pizza',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk'],
    prices: PIZZA_SIZES(199, 249, 299),
  },
  gluten_free_base: {
    name: 'Gluten-free base',
    description: 'Swap to a gluten-free base. Small 10" only. Prepared in a kitchen that handles gluten',
    appliesTo: 'pizza',
    prices: [{ size: 'small', label: 'Small 10"', unitAmount: 200 }],
  },
}

const SIDE = {
  garlic_bread: {
    name: 'Garlic bread',
    description: 'Four slices of stone-baked garlic bread',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk'],
    popular: true,
    prices: SINGLE(399, '4 slices'),
  },
  cheesy_garlic_bread: {
    name: 'Cheesy garlic bread',
    description: 'Four slices of garlic bread topped with melted mozzarella',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk'],
    prices: SINGLE(499, '4 slices'),
  },
  chips: {
    name: 'Chips',
    description: 'Skin-on chips with sea salt',
    dietary: ['vegetarian', 'vegan'],
    allergens: [],
    prices: SINGLE(299),
  },
  cheesy_chips: {
    name: 'Cheesy chips',
    description: 'Skin-on chips loaded with melted cheddar',
    dietary: ['vegetarian'],
    allergens: ['milk'],
    prices: SINGLE(399),
  },
  potato_wedges: {
    name: 'Potato wedges',
    description: 'Seasoned potato wedges',
    dietary: ['vegetarian', 'vegan'],
    allergens: ['celery'],
    prices: SINGLE(399),
  },
  chicken_wings: {
    name: 'Chicken wings',
    description: 'Crispy wings tossed in your choice of sauce',
    allergens: ['celery', 'mustard'],
    options: [{ name: 'sauce', required: true, choices: ['BBQ', 'Buffalo', 'Salt & pepper'] }],
    popular: true,
    prices: [
      { size: 'six', label: '6 wings', unitAmount: 599 },
      { size: 'twelve', label: '12 wings', unitAmount: 1049 },
    ],
  },
  chicken_strips: {
    name: 'Chicken strips',
    description: 'Five breaded chicken breast strips',
    allergens: ['gluten', 'eggs'],
    prices: SINGLE(549, '5 strips'),
  },
  mozzarella_sticks: {
    name: 'Mozzarella sticks',
    description: 'Six breaded mozzarella sticks',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk', 'eggs'],
    prices: SINGLE(499, '6 sticks'),
  },
  onion_rings: {
    name: 'Onion rings',
    description: 'Eight battered onion rings',
    dietary: ['vegetarian', 'vegan'],
    allergens: ['gluten'],
    prices: SINGLE(349, '8 rings'),
  },
  coleslaw: {
    name: 'Coleslaw',
    description: 'Creamy house coleslaw',
    dietary: ['vegetarian'],
    allergens: ['eggs', 'mustard'],
    prices: SINGLE(199, 'Pot'),
  },
}

const DIP = {
  garlic_and_herb_dip: {
    name: 'Garlic & herb dip',
    description: 'The classic',
    dietary: ['vegetarian'],
    allergens: ['eggs', 'milk'],
    popular: true,
    prices: SINGLE(99, 'Pot'),
  },
  bbq_dip: {
    name: 'BBQ dip',
    description: 'Smoky BBQ sauce',
    dietary: ['vegetarian', 'vegan'],
    allergens: ['mustard', 'celery'],
    prices: SINGLE(99, 'Pot'),
  },
  sweet_chilli_dip: {
    name: 'Sweet chilli dip',
    description: 'Sweet and mildly spicy',
    dietary: ['vegetarian', 'vegan'],
    spiceLevel: 1,
    allergens: [],
    prices: SINGLE(99, 'Pot'),
  },
  hot_buffalo_dip: {
    name: 'Hot buffalo dip',
    description: 'Tangy and hot',
    dietary: ['vegetarian'],
    spiceLevel: 2,
    allergens: ['milk'],
    prices: SINGLE(99, 'Pot'),
  },
}

const DRINK = {
  coca_cola: { name: 'Coca-Cola', description: 'Original taste', prices: DRINK_SIZES(170, 349), popular: true },
  diet_coke: { name: 'Diet Coke', description: 'No sugar', prices: DRINK_SIZES(170, 349) },
  coke_zero: { name: 'Coca-Cola Zero Sugar', description: 'No sugar', prices: DRINK_SIZES(170, 349) },
  fanta_orange: { name: 'Fanta Orange', description: 'Orange', prices: DRINK_SIZES(170, 349) },
  sprite: { name: 'Sprite', description: 'Lemon and lime', prices: DRINK_SIZES(170, 349) },
  still_water: {
    name: 'Still water',
    description: 'Spring water',
    prices: [{ size: 'bottle', label: '500ml bottle', unitAmount: 120 }],
  },
}

const DESSERT = {
  chocolate_fudge_cake: {
    name: 'Chocolate fudge cake',
    description: 'A warm slice of chocolate fudge cake',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk', 'eggs', 'soya'],
    prices: SINGLE(449, 'Slice'),
  },
  warm_cookie_dough: {
    name: 'Warm cookie dough',
    description: 'Gooey baked cookie dough with chocolate chunks',
    dietary: ['vegetarian'],
    allergens: ['gluten', 'milk', 'eggs', 'soya'],
    prices: SINGLE(499),
  },
  ice_cream_tub: {
    name: "Ben & Jerry's tub",
    description: '465ml tub of ice cream',
    dietary: ['vegetarian'],
    allergens: ['milk', 'eggs', 'gluten', 'soya'],
    options: [{ name: 'flavour', required: true, choices: ['Cookie Dough', 'Chocolate Fudge Brownie', 'Phish Food'] }],
    prices: SINGLE(749, '465ml tub'),
  },
}

const MEAL_DEAL = {
  solo_deal: {
    name: 'Solo deal',
    description: 'Any small pizza, a side and a can',
    includes: [
      { category: 'pizza', size: 'small', quantity: 1 },
      { choiceOf: ['garlic_bread', 'chips', 'potato_wedges'], quantity: 1 },
      { category: 'drink', size: 'can', quantity: 1 },
    ],
    prices: SINGLE(1499, 'Deal'),
  },
  meal_for_two: {
    name: 'Meal for two',
    description: 'Any two medium pizzas, two sides and a 1.5L bottle',
    includes: [
      { category: 'pizza', size: 'medium', quantity: 2 },
      { choiceOf: ['garlic_bread', 'chips', 'potato_wedges', 'onion_rings', 'coleslaw'], quantity: 2 },
      { category: 'drink', size: 'bottle', quantity: 1 },
    ],
    popular: true,
    prices: SINGLE(2999, 'Deal'),
  },
  family_feast: {
    name: 'Family feast',
    description: 'Any two large pizzas, cheesy garlic bread, 6 wings, chips and a 1.5L bottle',
    includes: [
      { category: 'pizza', size: 'large', quantity: 2 },
      { item: 'cheesy_garlic_bread', quantity: 1 },
      { item: 'chicken_wings', size: 'six', quantity: 1 },
      { item: 'chips', quantity: 1 },
      { category: 'drink', size: 'bottle', quantity: 1 },
    ],
    prices: SINGLE(3999, 'Deal'),
  },
}

const withCategory = (category, items) =>
  Object.entries(items).map(([id, item]) => ({
    id,
    category,
    dietary: [],
    allergens: [],
    spiceLevel: 0,
    popular: false,
    ...item,
  }))

export const MENU = [
  ...withCategory('pizza', PIZZA),
  ...withCategory('pizza_extra', PIZZA_EXTRA),
  ...withCategory('side', SIDE),
  ...withCategory('dip', DIP),
  ...withCategory('drink', DRINK),
  ...withCategory('dessert', DESSERT),
  ...withCategory('meal_deal', MEAL_DEAL),
]
