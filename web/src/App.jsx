import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Toaster, toast } from 'sonner'

import Captions from './Captions'
import HouseRules from './HouseRules'
import MenuBoard from './MenuBoard'
import Ticket from './Ticket'
import ReceiptPrinter from './printer/ReceiptPrinter'
import { IS_LIVE, useDemoPlayer, useLiveFeed } from './feed'
import { RESTAURANT, defaultSize, lineTitle, nextNudge } from './menu'
import { initialOrder, orderReducer } from './order'
import { POLICY_BY_ID } from './policy'

// The 3D build-your-own takeover. Loaded in the background so it opens instantly.
const loadBuildMode = () => import('./build/BuildMode')
const BuildMode = lazy(loadBuildMode)

const DEMO_CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_roccos_demo'
const GLOW_MS = 1600
// ?ticket shows the old paper ticket instead of the receipt printer.
const USE_TICKET = new URLSearchParams(location.search).has('ticket')

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// A chip that flies from the menu card to its new line on the ticket.
const flyToTicket = (itemId, lineId, label) => {
  if (reducedMotion()) return
  const from = document.querySelector(`.board [data-item="${itemId}"]`)?.getBoundingClientRect()
  const to = document.querySelector('.printer-slot')?.getBoundingClientRect() ?? document.querySelector(`[data-line="${lineId}"]`)?.getBoundingClientRect()
  if (!from || !to || from.bottom < 0 || from.top > window.innerHeight) return

  const chip = document.createElement('div')
  chip.className = 'fly-chip'
  chip.textContent = label
  document.body.append(chip)
  const { width, height } = chip.getBoundingClientRect()
  const startX = from.left + from.width / 2 - width / 2
  const startY = from.top + from.height / 2 - height / 2
  const endX = to.left + to.width / 2 - width / 2
  const endY = to.top - height / 2
  const animation = chip.animate(
    [
      { transform: `translate(${startX}px, ${startY}px) scale(0.96)`, opacity: 0 },
      { transform: `translate(${startX}px, ${startY - 8}px) scale(1)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${endX}px, ${endY}px) scale(0.92)`, opacity: 1, offset: 0.88 },
      { transform: `translate(${endX}px, ${endY}px) scale(0.92)`, opacity: 0 },
    ],
    { duration: 620, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'forwards' },
  )
  animation.onfinish = () => chip.remove()
}

function DemoBar({ demo, hidden }) {
  if (hidden) return null
  const done = demo.step >= demo.total
  return (
    <div className="demo-bar" role="toolbar" aria-label="Demo controls" title="Keys: → next · A auto · R reset · P paid · B build your own · H hide">
      <span className="demo-step">Demo {Math.min(demo.step + 1, demo.total)}/{demo.total}</span>
      <span className="demo-next-label">{done ? 'Script finished' : demo.label}</span>
      <button className="button button-small" onClick={demo.next} disabled={demo.busy || done}>Next →</button>
      <button className="button button-small" data-on={demo.auto} onClick={() => demo.setAuto(!demo.auto)}>{demo.auto ? 'Pause' : 'Auto'}</button>
      <button className="button button-small" onClick={demo.reset}>Reset</button>
    </div>
  )
}

export default function App() {
  const [order, dispatch] = useReducer(orderReducer, undefined, initialOrder)
  const demo = useDemoPlayer(dispatch)
  const buildRef = useRef(null)
  buildRef.current = order.build
  const live = useLiveFeed(dispatch, buildRef)
  const [glow, setGlow] = useState(null)
  const [flashes, setFlashes] = useState({})
  const [demoHidden, setDemoHidden] = useState(IS_LIVE)
  const { lastEvent } = order

  // Light up the card, fly the chip, flash the changed line.
  useLayoutEffect(() => {
    if (!lastEvent) return
    if (['add', 'update', 'remove'].includes(lastEvent.type)) setGlow({ itemId: lastEvent.itemId, seq: lastEvent.seq })
    if (lastEvent.type === 'add') {
      const line = order.lines.find((candidate) => candidate.id === lastEvent.lineId)
      // With the printer, things only reach the paper by printing out of the slot.
      if (USE_TICKET) flyToTicket(lastEvent.itemId, lastEvent.lineId, lineTitle(line))
    }
    if (lastEvent.type === 'update' || lastEvent.type === 'remove') setFlashes((current) => ({ ...current, [lastEvent.lineId]: lastEvent.seq }))
    if (lastEvent.type === 'reject') {
      toast(lastEvent.reason, {
        description: [lastEvent.suggestion, `${lastEvent.rule} · ${POLICY_BY_ID[lastEvent.rule]?.short}`].filter(Boolean).join(' · '),
      })
    }
    if (lastEvent.type === 'blocked') toast('Not quite ready to pay', { description: lastEvent.reasons.map((reason) => reason.text).join(' · ') })
    if (lastEvent.type === 'notice') toast(lastEvent.text)
  }, [lastEvent?.seq])

  useEffect(() => {
    if (!glow) return
    const timer = setTimeout(() => setGlow(null), GLOW_MS)
    return () => clearTimeout(timer)
  }, [glow])

  // Without Che's server there is no real Checkout Session, so the demo makes a placeholder one.
  useEffect(() => {
    if (IS_LIVE || order.phase !== 'confirmed') return
    const timer = setTimeout(() => dispatch({ type: 'checkout_ready', url: DEMO_CHECKOUT_URL }), 900)
    return () => clearTimeout(timer)
  }, [order.phase])

  useEffect(() => {
    const timer = setTimeout(() => loadBuildMode().then(() => import('./build/PizzaScene')), 800)
    return () => clearTimeout(timer)
  }, [])

  const say = useCallback((text) => live.send({ type: 'text', text }), [live])

  const actions = useMemo(() => ({
    pick: (item) => {
      const size = defaultSize(item)
      if (IS_LIVE) return say(`one ${item.name}`)
      dispatch({ type: 'add', item: item.id, size, quote: null })
    },
    addNudge: (nudge) => {
      if (IS_LIVE) return say(`one ${nudge.item.name}`)
      dispatch({ type: 'add', item: nudge.item.id, size: nudge.size, quote: null })
    },
    choose: (line, name, choice) => dispatch({ type: 'update', line: line.id, options: { [name]: choice }, quote: null }),
    finish: () => dispatch({ type: 'confirm_request' }),
    confirm: () => {
      dispatch({ type: 'confirmed' })
      if (IS_LIVE) live.send({ type: 'done' })
    },
    build: () => dispatch({ type: 'build_open', quote: null }),
    editAgain: () => dispatch({ type: 'edit_again' }),
    approve: () => dispatch({ type: 'approve' }),
    reset: () => {
      if (IS_LIVE) live.resetLive()
      demo.reset()
    },
  }), [say, live, demo])

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.closest('input, textarea') || event.metaKey || event.ctrlKey) return
      if (event.key === 'ArrowRight') demo.next()
      else if (event.key === 'a') demo.setAuto(!demo.auto)
      else if (event.key === 'r') actions.reset()
      else if (event.key === 'h') setDemoHidden((value) => !value)
      else if (event.key === 'p') dispatch({ type: 'paid' })
      else if (event.key === 'b') dispatch({ type: order.build ? 'build_cancel' : 'build_open', quote: null })
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demo, actions, order.build])

  const spotlight = order.phase === 'ordering' ? nextNudge(order.lines)?.course.category : null

  return (
    <div className="app" data-phase={order.phase}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Rocco's</span>
          <span className="brand-tagline">{RESTAURANT.tagline}</span>
        </div>
        <div className="topbar-right">
          {IS_LIVE && <span className="live-status" data-on={live.connected}>{live.connected ? 'Connected' : 'Connecting…'}</span>}
          <DemoBar demo={demo} hidden={demoHidden} />
          <HouseRules lines={order.lines} />
        </div>
      </header>

      <MenuBoard lines={order.lines} glowItemId={glow?.itemId} spotlight={spotlight} onPick={actions.pick} onBuild={actions.build} />
      {USE_TICKET ? <Ticket order={order} flashes={flashes} actions={actions} /> : <ReceiptPrinter order={order} actions={actions} />}
      <Captions captions={order.captions} live={IS_LIVE ? { on: live.micOn, button: live.toggleMic } : { on: true }} />
      <Suspense fallback={null}>
        <AnimatePresence>
          {order.build && <BuildMode key="build" build={order.build} captions={order.captions} dispatch={dispatch} />}
        </AnimatePresence>
      </Suspense>
      <Toaster position="top-center" toastOptions={{ className: 'toast' }} />
    </div>
  )
}
