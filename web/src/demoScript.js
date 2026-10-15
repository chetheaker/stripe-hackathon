// The scripted conversation for rehearsing and recording the demo.
// Each step: the customer speaks, the events apply, then Rocco's replies.
export const DEMO_SCRIPT = [
  {
    customer: 'Hi, can I get a large pepperoni with stuffed crust please',
    events: [{ type: 'add', item: 'pepperoni', size: 'large', extras: ['stuffed_crust'] }],
  },
  {
    customer: 'and a medium margherita, no basil oil',
    events: [{ type: 'add', item: 'margherita', size: 'medium', without: ['basil oil'] }],
  },
  {
    customer: 'actually make the margherita a large',
    events: [{ type: 'update', line: 'margherita', size: 'large' }],
  },
  {
    customer: 'can I get a calzone as well?',
    events: [{ type: 'reject', reason: 'We don\'t do calzones', suggestion: 'The Meat Feast is a good shout' }],
    agent: 'Sorry, calzones aren\'t on our menu. The Meat Feast is a good shout if you want something hearty.',
  },
  {
    customer: 'go on then, twelve chicken wings',
    events: [{ type: 'add', item: 'chicken_wings', size: 'twelve' }],
    agent: 'Which sauce on the wings? BBQ, Buffalo or salt and pepper?',
  },
  {
    customer: 'buffalo please',
    events: [{ type: 'update', line: 'chicken_wings', options: { sauce: 'Buffalo' } }],
  },
  {
    customer: 'and a garlic and herb dip',
    events: [{ type: 'add', item: 'garlic_and_herb_dip' }],
  },
  {
    customer: 'a bottle of Coke too',
    events: [{ type: 'add', item: 'coca_cola', size: 'bottle' }],
  },
  {
    customer: 'actually drop the Coke, make it a Diet Coke',
    events: [
      { type: 'remove', line: 'coca_cola' },
      { type: 'add', item: 'diet_coke', size: 'bottle' },
    ],
    agent: 'Room for pudding? The warm cookie dough is lovely.',
  },
  {
    customer: 'go on, a cookie dough',
    events: [{ type: 'add', item: 'warm_cookie_dough' }],
  },
  {
    customer: 'that\'s everything',
    events: [{ type: 'confirm_request' }],
    agent: 'A large pepperoni with stuffed crust, a large margherita with no basil oil, twelve Buffalo wings, a garlic and herb dip, a Diet Coke bottle and a cookie dough. Is that right?',
  },
  {
    customer: 'yep, that\'s right',
    events: [{ type: 'confirmed' }],
    agent: 'Lovely. Scan the code to pay.',
  },
  {
    label: 'Customer pays',
    events: [{ type: 'paid' }],
  },
]

// Build your own: talk a pizza into existence in 3D, then carry on and pay. Open with /?script=build.
export const BUILD_SCRIPT = [
  {
    customer: 'Hiya, can I make my own pizza?',
    events: [{ type: 'build_open' }],
    agent: 'Course you can. What size are we making?',
  },
  {
    customer: 'a large one please, with stuffed crust',
    events: [{ type: 'build', size: 'large', crust: 'stuffed' }],
    agent: 'Tomato, BBQ or garlic and herb?',
  },
  {
    customer: 'tomato sauce',
    events: [{ type: 'build', sauce: 'tomato' }],
  },
  {
    customer: 'and loads of mozzarella',
    events: [{ type: 'build', cheese: 'mozzarella' }],
    agent: 'Lovely. What are we putting on it?',
  },
  {
    customer: 'pepperoni, mushrooms and jalapeños',
    events: [
      { type: 'build', add: ['pepperoni'] },
      { type: 'build', add: ['mushrooms'] },
      { type: 'build', add: ['jalapenos'] },
    ],
  },
  {
    customer: 'can I get anchovies on it?',
    events: [{ type: 'reject', rule: 'R1', reason: 'Sorry, anchovies aren\'t on our build-your-own menu', suggestion: 'Nduja is a good shout' }],
    agent: 'Sorry, no anchovies. The nduja is a good shout if you like it salty and spicy.',
  },
  {
    customer: 'go on then, nduja. actually, no mushrooms',
    events: [
      { type: 'build', add: ['nduja'] },
      { type: 'build', remove: ['mushrooms'] },
    ],
  },
  {
    customer: 'and some fresh basil on top',
    events: [{ type: 'build', add: ['basil'] }],
  },
  {
    customer: 'that\'s it, bake it!',
    events: [{ type: 'build_bake' }],
    agent: 'Into the oven it goes.',
    pause: 3600,
  },
  {
    customer: 'and a can of Diet Coke',
    events: [{ type: 'add', item: 'diet_coke', size: 'can' }],
  },
  {
    customer: 'that\'s everything',
    events: [{ type: 'confirm_request' }],
    agent: 'A large build-your-own on stuffed crust with tomato, mozzarella, pepperoni, jalapeños, nduja and basil, and a can of Diet Coke. Is that right?',
  },
  {
    customer: 'yep, that\'s right',
    events: [{ type: 'confirmed' }],
    agent: 'Lovely. Scan the code to pay.',
  },
  {
    label: 'Customer pays',
    events: [{ type: 'paid' }],
  },
]
