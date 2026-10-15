import { useEffect, useRef, useState } from 'react'

import { RESTAURANT } from './menu'
import { POLICY } from './policy'

// The written policy, with a count of how often each rule has been applied to this order.
export default function HouseRules({ lines }) {
  const [open, setOpen] = useState(false)
  const panel = useRef(null)

  const uses = {}
  for (const line of lines) {
    for (const entry of line.history) entry.rules.forEach((id) => { uses[id] = (uses[id] ?? 0) + 1 })
  }

  useEffect(() => {
    if (!open) return
    const close = (event) => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !panel.current?.parentElement.contains(event.target))) setOpen(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', close)
    }
  }, [open])

  return (
    <div className="rules">
      <button className="button button-ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        House rules
      </button>
      <div ref={panel} className="rules-panel" data-open={open} role="dialog" aria-label="House rules">
        <h3>What Rocco's assistant can and can't do</h3>
        <ol>
          {POLICY.map((rule) => (
            <li key={rule.id}>
              <span className="rule-chip">{rule.id}</span>
              <span className="rule-text">
                <b>{rule.short}.</b> {rule.text}
              </span>
              {uses[rule.id] > 0 && <span className="rule-uses">{uses[rule.id]}×</span>}
            </li>
          ))}
        </ol>
        <p className="rules-notice">{RESTAURANT.allergenNotice}</p>
      </div>
    </div>
  )
}
