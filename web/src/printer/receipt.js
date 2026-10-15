import { RESTAURANT, formatPrice, lineTitle, linePricing, orderTotal, liveLines } from '../menu'
import { missingOptions } from '../order'

// Every row has a fixed height so the printer knows exactly how far to feed.
export const ROW_HEIGHTS = {
  brand: 40, center: 17, rule: 14, gap: 10, space: 7, item: 22, sub: 17, warn: 17, total: 30, qr: 168,
}

export const LEAD = 22
export const TAIL = 34
const RULE = '- - - - - - - - - - - - - - - - - - - - - -'

const row = (kind, left = '', right = '') => ({ kind, left, right })

const pad = (n) => String(n).padStart(2, '0')
const stampFor = (date) => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`

const headerBlock = (orderNo, startedAt) => ({
  key: 'header',
  rows: [
    row('brand', RESTAURANT.name.toUpperCase()),
    row('center', 'STONE-BAKED SINCE 1998'),
    row('center', 'TAKEAWAY'),
    row('gap'),
    row('sub', `ORDER #${String(orderNo).padStart(4, '0')}`, stampFor(startedAt)),
    row('rule', RULE),
    row('gap'),
  ],
})

// Like a real till: the item at its base price, then each modifier indented beneath it.
const lineBlock = (line) => {
  const pricing = linePricing(line)
  const rows = [row('item', `${line.quantity} x ${lineTitle(line)}`, formatPrice(pricing.base.unitAmount * line.quantity))]
  pricing.extras.forEach((extra) => rows.push(row('sub', `    + ${extra.name}`, formatPrice(extra.unitAmount * line.quantity))))
  line.without.forEach((topping) => rows.push(row('sub', `    No ${topping}`)))
  Object.entries(line.options).forEach(([name, choice]) => rows.push(row('sub', `    ${name[0].toUpperCase()}${name.slice(1)}: ${choice}`)))
  if (line.note) rows.push(row('sub', `    Note: ${line.note}`))
  missingOptions(line).forEach((option) => rows.push(row('warn', `    ! CHOOSE A ${option.name.toUpperCase()}`)))
  rows.push(row('space'))
  return { key: line.id, rows }
}

const footerBlock = (lines, checkoutUrl) => {
  const total = orderTotal(lines)
  const count = liveLines(lines).reduce((sum, line) => sum + line.quantity, 0)
  return {
    key: 'footer',
    rows: [
      row('rule', RULE),
      row('sub', `${count} ${count === 1 ? 'ITEM' : 'ITEMS'}`),
      row('total', 'TOTAL', formatPrice(total)),
      // UK prices include 20% VAT, so the VAT share is a sixth of the total.
      row('sub', 'incl. VAT 20%', formatPrice(Math.round(total / 6))),
      row('gap'),
      row('center', 'SCAN TO PAY'),
      { ...row('qr'), url: checkoutUrl },
      row('center', 'Secure checkout by Stripe'),
      row('gap'),
      row('center', 'THANK YOU, SEE YOU SOON'),
    ],
  }
}

// What the paper should say right now, top to bottom, in the order it prints.
export const receiptBlocks = (order, startedAt) => {
  const blocks = [headerBlock(order.orderNo, startedAt), ...liveLines(order.lines).map(lineBlock)]
  if (order.checkoutUrl && (order.phase === 'checkout' || order.phase === 'paid')) blocks.push(footerBlock(order.lines, order.checkoutUrl))
  return blocks.map((block) => ({
    ...block,
    sig: JSON.stringify(block.rows),
    height: block.rows.reduce((sum, r) => sum + ROW_HEIGHTS[r.kind], 0),
  }))
}

// The print head sits at the slot, so while ordering the paper stops right after the last line;
// any blank tail fed now would already be outside when the next line is added, and that line would
// pop into view instead of printing out. Only the finished receipt feeds a tail to clear the cutter.
export const paperLength = (blocks) => {
  const finished = blocks.some((block) => block.key === 'footer')
  return LEAD + blocks.reduce((sum, block) => sum + block.height, 0) + (finished ? TAIL : 0)
}

export const offsetOf = (blocks, index) => LEAD + blocks.slice(0, index).reduce((sum, block) => sum + block.height, 0)
