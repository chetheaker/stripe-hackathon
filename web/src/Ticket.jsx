import { AnimatePresence, motion } from 'motion/react'
import { QRCodeSVG } from 'qrcode.react'

import { ITEMS_BY_ID, formatPrice, lineTitle, linePricing, liveLines, nextNudge, orderTotal } from './menu'
import { blockers, missingOptions } from './order'
import { POLICY_BY_ID } from './policy'
import RollingPrice from './RollingPrice'

const EASE_OUT = [0.23, 1, 0.32, 1]

const PHASE_LABELS = {
  ordering: 'Taking your order',
  confirming: 'Reading it back',
  confirmed: 'Making your payment link',
  checkout: 'Ready to pay',
  paid: 'Paid',
}

function RuleChips({ rules }) {
  return (
    <span className="rule-chips">
      {rules.map((id) => (
        <span key={id} className="rule-chip" title={POLICY_BY_ID[id].text}>
          {id} {POLICY_BY_ID[id].short}
        </span>
      ))}
    </span>
  )
}

function TicketLine({ line, index, flashSeq, onChoose }) {
  const pricing = linePricing(line)
  const item = ITEMS_BY_ID[line.itemId]
  const missing = missingOptions(line)
  const options = Object.entries(line.options)

  return (
    <motion.li
      layout="position"
      className="line"
      data-line={line.id}
      data-removed={line.removed}
      style={{ '--readback-delay': `${index * 450}ms` }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.25, delay: 0.3, ease: EASE_OUT } }}
      transition={{ layout: { duration: 0.25, ease: EASE_OUT } }}
    >
      <div className="line-main" key={flashSeq} data-flash={flashSeq != null}>
        <span className="line-qty">{line.quantity}×</span>
        <span className="line-title">{lineTitle(line)}</span>
        <span className="line-price">{formatPrice(line.removed ? linePricing({ ...line, removed: false }).total : pricing.total)}</span>
      </div>

      {!line.removed && (
        <div className="line-details">
          {pricing.extras.map((extra) => (
            <div key={extra.id} className="line-detail">
              <span>+ {extra.name}</span>
              <span>{formatPrice(extra.unitAmount * line.quantity)}</span>
            </div>
          ))}
          {line.custom && <div className="line-detail">{line.custom.sauce} sauce · {line.custom.cheese}</div>}
          {line.without.map((topping) => <div key={topping} className="line-detail">No {topping}</div>)}
          {options.map(([name, choice]) => <div key={name} className="line-detail">{name[0].toUpperCase() + name.slice(1)}: {choice}</div>)}
          {line.note && <div className="line-detail">Note: {line.note}</div>}
          {missing.map((option) => (
            <div key={option.name} className="line-needs">
              <span>Choose a {option.name}</span>
              <span className="needs-choices">
                {option.choices.map((choice) => (
                  <button key={choice} className="choice" onClick={() => onChoose(line, option.name, choice)}>{choice}</button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      <ol className="audit">
        {line.history.map((entry) => (
          <li key={entry.seq} className="audit-entry">
            <span className="audit-change">{entry.change}</span>
            <span className="audit-quote">{entry.quote ? `“${entry.quote}”` : 'Tapped on screen'}</span>
            <RuleChips rules={entry.rules} />
          </li>
        ))}
      </ol>
      {item.allergens?.length > 0 && !line.removed && <div className="line-allergens">Contains {item.allergens.join(', ')}</div>}
    </motion.li>
  )
}

function Nudge({ nudge, onAdd }) {
  if (!nudge) return null
  return (
    <button key={nudge.course.category} className="nudge" onClick={() => onAdd(nudge)}>
      <span className="nudge-ask">{nudge.course.nudge}</span>
      <span className="nudge-item">
        {nudge.item.name} <b>{formatPrice(nudge.unitAmount)}</b>
      </span>
      <span className="nudge-plus" aria-hidden="true">+</span>
    </button>
  )
}

function Front({ order, flashes, actions }) {
  const total = orderTotal(order.lines)
  const reasons = blockers(order)
  const hasLines = liveLines(order.lines).length > 0
  const nudge = order.phase === 'ordering' ? nextNudge(order.lines) : null

  return (
    <div className="ticket-face ticket-front">
      <header className="ticket-head">
        <div>
          <div className="ticket-brand">Rocco's Pizza</div>
          <div className="ticket-meta">Order #{order.orderNo} · Counter</div>
        </div>
        <div className="ticket-phase" data-phase={order.phase}>{PHASE_LABELS[order.phase]}</div>
      </header>

      <div className="ticket-lines">
        {order.lines.length === 0 && (
          <div className="ticket-empty">
            <p>Say what you fancy.</p>
            <p>Your order builds up here, line by line.</p>
          </div>
        )}
        <ul>
          <AnimatePresence initial={false}>
            {order.lines.map((line, index) => (
              <TicketLine key={line.id} line={line} index={index} flashSeq={flashes[line.id]} onChoose={actions.choose} />
            ))}
          </AnimatePresence>
        </ul>
      </div>

      <footer className="ticket-foot">
        <Nudge nudge={nudge} onAdd={actions.addNudge} />
        {hasLines && reasons.length > 0 && (
          <div className="ticket-blockers">
            {reasons.map((reason) => (
              <div key={reason.text} className="blocker">
                <span className="rule-chip">{reason.rule}</span> {reason.text}
                {reason.approval && <button className="link-button" onClick={actions.approve}>Staff: approve</button>}
              </div>
            ))}
          </div>
        )}
        <div className="ticket-total">
          <span>Total</span>
          <RollingPrice amount={total} />
        </div>
        <div className="ticket-cta">
          {order.phase === 'ordering' && (
            <button className="button button-primary" disabled={!hasLines} onClick={actions.finish}>That's everything</button>
          )}
          {order.phase === 'confirming' && (
            <>
              <button className="button button-quiet" onClick={actions.editAgain}>Change something</button>
              <button className="button button-primary" onClick={actions.confirm}>Yes, that's right</button>
            </>
          )}
          {order.phase === 'confirmed' && <div className="ticket-waiting">Making your payment link<span className="dots" /></div>}
        </div>
      </footer>
    </div>
  )
}

function Back({ order, actions }) {
  const total = orderTotal(order.lines)
  const paid = order.phase === 'paid'
  return (
    <div className="ticket-face ticket-back" data-paid={paid}>
      <header className="ticket-head">
        <div>
          <div className="ticket-brand">Rocco's Pizza</div>
          <div className="ticket-meta">Order #{order.orderNo}</div>
        </div>
        <div className="ticket-phase" data-phase={order.phase}>{PHASE_LABELS[order.phase]}</div>
      </header>

      <div className="pay">
        <h2 className="pay-title">{paid ? 'Thank you!' : 'Scan to pay'}</h2>
        <div className="pay-total">{formatPrice(total)}</div>
        <div className="pay-qr">
          {order.checkoutUrl && <QRCodeSVG value={order.checkoutUrl} size={232} bgColor="transparent" fgColor="#1d1a17" marginSize={0} />}
          {paid && <div className="stamp">Paid</div>}
        </div>
        {paid ? (
          <p className="pay-note">Your pizza will be ready in about 15 minutes.</p>
        ) : (
          <>
            <p className="pay-note">Pay with your phone. Card, Apple Pay or Google Pay.</p>
            {order.checkoutUrl && <a className="pay-link" href={order.checkoutUrl} target="_blank" rel="noreferrer">Open checkout ↗</a>}
            <div className="ticket-waiting">Waiting for payment<span className="dots" /></div>
          </>
        )}
        <p className="pay-small">Secure checkout by Stripe · test mode</p>
      </div>

      {paid && (
        <div className="ticket-cta">
          <button className="button button-quiet" onClick={actions.reset}>Next customer</button>
        </div>
      )}
    </div>
  )
}

export default function Ticket({ order, flashes, actions }) {
  const flipped = order.phase === 'checkout' || order.phase === 'paid'
  return (
    <aside className="ticket-wrap" data-phase={order.phase}>
      <div className="ticket" data-flipped={flipped}>
        <Front order={order} flashes={flashes} actions={actions} />
        <Back order={order} actions={actions} />
      </div>
    </aside>
  )
}
