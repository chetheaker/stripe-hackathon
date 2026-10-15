import { RESTAURANT, formatPrice, lineTitle, linePricing, orderTotal, liveLines } from '../menu'
import { missingOptions } from '../order'

// Every row has a fixed height so the printer knows exactly how far to feed.
export const ROW_HEIGHTS = {
  brand: 40, center: 17, rule: 14, gap: 10, item: 22, sub: 17, quote: 15, rules: 15, warn: 17, total: 30, qr: 168,
}

export const LEAD = 22
export const TAIL = 34
const QUOTE_CHARS = 44
const RULE = '- - - - - - - - - - - - - - - - - - - - - -'

const row = (kind, left = '', right = '') => ({ kind, left, right })

const wrap = (prefix, text) => {
  const lines = []
  let current = prefix
  for (const word of text.split(' ')) {
    const fresh = current === prefix || current === '    '
    if (!fresh && (current + ' ' + word).length > QUOTE_CHARS) {
      lines.push(current)
      current = '    '
    }
    current = current === prefix || current === '    ' ? current + word : `${current} ${word}`
  }
  lines.push(current)
  return lines
}

const pad = (n) => String(n).padStart(2, '0')
const stampFor = (date) => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`

const headerBlock = (orderNo, startedAt) => ({
  key: 'header',
  rows: [
    row('brand', RESTAURANT.name.toUpperCase()),
    row('center', 'STONE-BAKED SINCE 1998'),
    row('gap'),
    row('sub', `ORDER #${String(orderNo).padStart(4, '0')}`, stampFor(startedAt)),
    row('rule', RULE),
    row('gap'),
  ],
})

const lineBlock = (line) => {
  const pricing = linePricing(line)
  const rows = [row('item', `${line.quantity} x ${lineTitle(line)}`, line.removed ? 'VOID' : formatPrice(pricing.total))]
  if (!line.removed) {
    pricing.extras.forEach((extra) => rows.push(row('sub', `    + ${extra.name}`, formatPrice(extra.unitAmount * line.quantity))))
    line.without.forEach((topping) => rows.push(row('sub', `    No ${topping}`)))
    Object.entries(line.options).forEach(([name, choice]) => rows.push(row('sub', `    ${name[0].toUpperCase()}${name.slice(1)}: ${choice}`)))
    if (line.note) rows.push(row('sub', `    Note: ${line.note}`))
    missingOptions(line).forEach((option) => rows.push(row('warn', `    ! CHOOSE A ${option.name.toUpperCase()}`)))
  }
  line.history.forEach((entry) => {
    const label = entry.change === 'Added' ? '' : `${entry.change.toUpperCase()} `
    const said = entry.quote ? `"${entry.quote}"` : '(tapped on screen)'
    wrap(`  ${label}`, said).forEach((text) => rows.push(row('quote', text)))
  })
  const rules = line.history.at(-1)?.rules ?? []
  rows.push(row('rules', `  OK  ${rules.join('  ')}`))
  rows.push(row('gap'))
  return { key: line.id, rows }
}

const footerBlock = (lines, checkoutUrl) => {
  const count = liveLines(lines).reduce((sum, line) => sum + line.quantity, 0)
  return {
    key: 'footer',
    rows: [
      row('rule', RULE),
      row('sub', 'ITEMS', String(count)),
      row('total', 'TOTAL', formatPrice(orderTotal(lines))),
      row('gap'),
      row('center', 'SCAN TO PAY'),
      { ...row('qr'), url: checkoutUrl },
      row('center', 'Card · Apple Pay · Google Pay'),
      row('center', 'Secure checkout by Stripe'),
      row('gap'),
      row('center', 'THANK YOU!'),
    ],
  }
}

// What the paper should say right now, top to bottom, in the order it prints.
export const receiptBlocks = (order, startedAt) => {
  const blocks = [headerBlock(order.orderNo, startedAt), ...order.lines.map(lineBlock)]
  if (order.checkoutUrl && (order.phase === 'checkout' || order.phase === 'paid')) blocks.push(footerBlock(order.lines, order.checkoutUrl))
  return blocks.map((block) => ({
    ...block,
    sig: JSON.stringify(block.rows),
    height: block.rows.reduce((sum, r) => sum + ROW_HEIGHTS[r.kind], 0),
  }))
}

export const paperLength = (blocks) => LEAD + blocks.reduce((sum, block) => sum + block.height, 0) + TAIL

export const offsetOf = (blocks, index) => LEAD + blocks.slice(0, index).reduce((sum, block) => sum + block.height, 0)
