import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

import { formatPrice, liveLines, orderTotal } from '../menu'
import { LEAD, ROW_HEIGHTS, offsetOf, paperLength, receiptBlocks } from './receipt'
import { printStep, reverseStep } from './sound'
import './printer.css'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// The display counts to a new total like a till: fast at first, then settling.
const useCountUp = (target) => {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = performance.now()
    const begin = from.current
    let frame
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 650)
      const value = Math.round(begin + (target - begin) * (1 - Math.pow(1 - t, 3)))
      from.current = value
      setShown(value)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

const LCD_LABELS = {
  ordering: 'RUNNING TOTAL',
  confirming: 'PLEASE CHECK',
  confirmed: 'TOTAL DUE',
  checkout: 'TOTAL DUE',
  paid: 'PAID  THANK YOU',
}

function Row({ row }) {
  if (row.kind === 'qr') {
    return (
      <div className="rx-row rx-qr">
        <QRCodeSVG value={row.url} size={150} bgColor="transparent" fgColor="#24221e" marginSize={0} />
      </div>
    )
  }
  return (
    <div className={`rx-row rx-${row.kind}`}>
      <span>{row.left}</span>
      <span>{row.right}</span>
    </div>
  )
}

export default function ReceiptPrinter({ order, actions, sound = true }) {
  const startedAt = useMemo(() => new Date(), [order.orderNo])
  const target = useMemo(() => receiptBlocks(order, startedAt), [order, startedAt])
  const signature = target.map((block) => block.sig).join('|')

  const [printed, setPrinted] = useState([])
  const [fed, setFed] = useState(0)
  const [wobble, setWobble] = useState(0)
  const [busy, setBusy] = useState(false)
  const [windowHeight, setWindowHeight] = useState(700)

  const targetRef = useRef(target)
  const printedRef = useRef([])
  const fedRef = useRef(0)
  const running = useRef(false)
  const dirty = useRef(false)
  const generation = useRef(0)
  const columnRef = useRef(null)
  targetRef.current = target

  const setPaper = (value, wob) => {
    fedRef.current = value
    setFed(value)
    setWobble(wob)
  }

  // Forward feed: small motor steps with uneven holds, and a longer pause as each line burns.
  const printTo = async (length, gen) => {
    if (reducedMotion()) return setPaper(length, 0)
    while (fedRef.current < length - 0.01) {
      if (gen !== generation.current) return
      const before = fedRef.current
      const next = Math.min(length, before + 3 + Math.random() * 4)
      setPaper(next, (Math.random() - 0.5) * 0.7)
      if (sound) printStep()
      const crossedLine = Math.floor(next / 17) !== Math.floor(before / 17)
      await sleep(crossedLine ? 50 + Math.random() * 70 : 14 + Math.random() * 20)
    }
    setWobble(0)
  }

  // Reverse feed: the motor whirs the paper back in, smooth and quick.
  const pullTo = async (length, gen) => {
    if (reducedMotion()) return setPaper(length, 0)
    await sleep(140)
    while (fedRef.current > length + 0.01) {
      if (gen !== generation.current) return
      setPaper(Math.max(length, fedRef.current - (11 + Math.random() * 5)), (Math.random() - 0.5) * 0.4)
      if (sound) reverseStep()
      await sleep(16)
    }
    setWobble(0)
    await sleep(220)
  }

  // Bring the paper in line with the order: pull back to the first changed line, then print forward.
  const reconcile = async () => {
    if (running.current) {
      dirty.current = true
      return
    }
    running.current = true
    const gen = generation.current
    setBusy(true)
    try {
      do {
        dirty.current = false
        const next = targetRef.current
        const current = printedRef.current
        const diverge = current.findIndex((block, i) => next[i]?.key !== block.key || next[i]?.sig !== block.sig)
        if (diverge !== -1) await pullTo(offsetOf(current, diverge), gen)
        if (gen !== generation.current) return
        printedRef.current = next
        setPrinted(next)
        // Let the new rows render inside the printer before the motor starts feeding them out.
        await sleep(diverge !== -1 ? 140 : 60)
        await printTo(paperLength(next), gen)
      } while (dirty.current && gen === generation.current)
    } finally {
      if (gen === generation.current) {
        running.current = false
        setBusy(false)
      }
    }
  }

  // A new order starts a fresh roll.
  useEffect(() => {
    generation.current += 1
    running.current = false
    printedRef.current = []
    setPrinted([])
    setPaper(0, 0)
    const timer = setTimeout(reconcile, 300)
    return () => clearTimeout(timer)
  }, [order.orderNo])

  useEffect(() => {
    if (printedRef.current.length || running.current) reconcile()
  }, [signature])

  useEffect(() => {
    const measure = () => columnRef.current && setWindowHeight(columnRef.current.clientHeight - 125)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const total = useCountUp(orderTotal(order.lines))
  const hasLines = liveLines(order.lines).length > 0

  // Long orders: the view eases back so the whole receipt stays on screen.
  const room = windowHeight - 40
  const zoom = fed > room ? Math.max(0.55, room / fed) : 1

  let stampTop = null
  const footerIndex = printed.findIndex((block) => block.key === 'footer')
  if (order.phase === 'paid' && footerIndex !== -1) {
    const footer = printed[footerIndex]
    const qrIndex = footer.rows.findIndex((row) => row.kind === 'qr')
    stampTop = offsetOf(printed, footerIndex) + footer.rows.slice(0, qrIndex).reduce((sum, row) => sum + ROW_HEIGHTS[row.kind], 0) + 52
  }

  return (
    <aside className="printer-column" data-phase={order.phase} ref={columnRef}>
      <div className="printer-rig" style={{ transform: `scale(${zoom})` }}>
        <div className="printer-shadow" />
        <div className="printer-body" data-busy={busy}>
          <div className="printer-top">
            <div className="printer-slot" />
          </div>
          <div className="printer-face">
            <div className="lcd" aria-live="polite">
              <div className="lcd-label">{LCD_LABELS[order.phase]}</div>
              <div className="lcd-total">{formatPrice(total)}</div>
            </div>
            <div className="printer-controls">
              {order.phase === 'ordering' && (
                <button className="key key-primary" disabled={!hasLines} onClick={actions.finish}>That's everything</button>
              )}
              {order.phase === 'confirming' && (
                <>
                  <button className="key key-primary" onClick={actions.confirm}>Yes, that's right</button>
                  <button className="key" onClick={actions.editAgain}>Change something</button>
                </>
              )}
              {order.phase === 'confirmed' && <div className="printer-note">Making your payment link…</div>}
              {order.phase === 'checkout' && (
                <a className="printer-note printer-link" href={order.checkoutUrl} target="_blank" rel="noreferrer">Waiting for payment · open ↗</a>
              )}
              {order.phase === 'paid' && <button className="key" onClick={actions.reset}>Next customer</button>}
            </div>
            <div className="printer-led" data-busy={busy} />
            <div className="printer-badge">ROCCO'S</div>
          </div>
        </div>

        <div className="paper-window">
          <div className="paper" style={{ transform: `translate(${wobble}px, ${-fed}px)`, opacity: fed > 0.5 ? 1 : 0 }}>
            <svg className="paper-grain" aria-hidden="true">
              <filter id="paperGrain">
                <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
                <feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.33  0 0 0 0 0.3  0 0 0 0.09 0" />
              </filter>
              <rect width="100%" height="100%" filter="url(#paperGrain)" />
            </svg>
            <div className="paper-ink" style={{ paddingTop: LEAD }}>
              {printed.map((block) => (
                <div key={block.key} data-block={block.key}>
                  {block.rows.map((row, index) => <Row key={index} row={row} />)}
                </div>
              ))}
            </div>
            {stampTop !== null && (
              <div className="paid-stamp" style={{ top: stampTop }}>
                <svg aria-hidden="true" width="0" height="0">
                  <filter id="stampInk">
                    <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" result="noise" />
                    <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" />
                  </filter>
                </svg>
                PAID
              </div>
            )}
          </div>
          <div className="paper-shade" style={{ height: Math.min(14, fed) }} />
        </div>
      </div>
    </aside>
  )
}
