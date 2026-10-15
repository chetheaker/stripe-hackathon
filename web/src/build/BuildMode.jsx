import { Suspense, lazy, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { formatPrice, priceFor } from '../menu'
import { POLICY_BY_ID } from '../policy'
import RollingPrice from '../RollingPrice'
import {
  BASE_ITEM, CHEESES, CHEESES_BY_ID, CRUSTS, CRUSTS_BY_ID, MAX_TOPPINGS, SAUCES, SAUCES_BY_ID, SIZES, SIZES_BY_ID, STEPS, TOPPINGS,
  buildPricing, currentStep,
} from './buildModel'

const PizzaScene = lazy(() => import('./PizzaScene'))

const EASE_OUT = [0.23, 1, 0.32, 1]

const PROMPTS = {
  base: 'What size are we making?',
  sauce: 'Pick a sauce',
  cheese: 'And the cheese?',
  toppings: 'Pile on the toppings',
  bake: 'Into the oven',
}

const stepValue = (build, id) => {
  if (id === 'base') return build.size ? `${SIZES_BY_ID[build.size].label} ${SIZES_BY_ID[build.size].detail} · ${CRUSTS_BY_ID[build.crust].label}` : null
  if (id === 'sauce') return build.sauce ? SAUCES_BY_ID[build.sauce].label : null
  if (id === 'cheese') return build.cheese ? CHEESES_BY_ID[build.cheese].label : null
  if (id === 'toppings') return build.toppings.length ? `${build.toppings.length} topping${build.toppings.length > 1 ? 's' : ''}` : null
  if (id === 'bake') return build.stage === 'baking' ? 'Baking…' : null
  return null
}

function Steps({ build }) {
  const step = currentStep(build)
  const index = STEPS.findIndex((candidate) => candidate.id === step)
  return (
    <ol className="build-steps">
      {STEPS.map((candidate, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'todo'
        return (
          <li key={candidate.id} className="build-step" data-state={state}>
            <span className="build-step-dot">{state === 'done' ? '✓' : i + 1}</span>
            <span className="build-step-text">
              <span className="build-step-title">{candidate.title}</span>
              <span className="build-step-value">{stepValue(build, candidate.id) ?? candidate.hint}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Bill({ build }) {
  const { parts, total } = buildPricing(build)
  const quotes = build.history.filter((entry) => entry.quote).slice(-3)
  return (
    <aside className="build-bill">
      <div className="build-bill-kicker">Your pizza</div>
      <ul className="build-bill-parts">
        <AnimatePresence initial={false}>
          {parts.map((part) => (
            <motion.li
              key={part.id}
              layout="position"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
              transition={{ duration: 0.3, ease: EASE_OUT }}
            >
              <span>{part.label}</span>
              <span>{formatPrice(part.unitAmount)}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="build-bill-total">
        <span>Total</span>
        <RollingPrice amount={total} />
      </div>
      <p className="build-bill-rule">
        <span className="rule-chip">R2</span> {POLICY_BY_ID.R2.short}: a {SIZES_BY_ID[build.size ?? 'medium'].label.toLowerCase()} Margherita plus {formatPrice(priceFor('extra_topping', build.size ?? 'medium').unitAmount)} a topping, straight from the menu.
      </p>
      {quotes.length > 0 && (
        <ol className="build-bill-quotes">
          {quotes.map((entry) => (
            <li key={entry.seq}>
              <span className="build-quote">“{entry.quote}”</span>
              <span className="build-quote-change">{entry.change}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

function Chip({ on, onClick, children, disabled, note }) {
  return (
    <button className="build-chip" data-on={on} onClick={onClick} disabled={disabled}>
      {children}
      {note && <small>{note}</small>}
    </button>
  )
}

function Dock({ build, send, bake }) {
  const step = currentStep(build)
  const size = build.size ?? 'medium'
  const topping = formatPrice(priceFor('extra_topping', size).unitAmount)
  return (
    <div className="build-dock">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          className="build-dock-inner"
          initial={{ opacity: 0, y: 14, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
          transition={{ duration: 0.28, ease: EASE_OUT }}
        >
          <h2 className="build-prompt">{PROMPTS[step]}</h2>
          <p className="build-hint">Say {STEPS.find((candidate) => candidate.id === step).hint}, or tap</p>
          <div className="build-chips">
            {step === 'base' && SIZES.map((option) => (
              <Chip key={option.id} on={build.size === option.id} onClick={() => send({ size: option.id })} note={formatPrice(priceFor(BASE_ITEM, option.id).unitAmount)}>
                {option.label} {option.detail}
              </Chip>
            ))}
            {step === 'sauce' && SAUCES.map((option) => <Chip key={option.id} on={build.sauce === option.id} onClick={() => send({ sauce: option.id })} note="Included">{option.label}</Chip>)}
            {step === 'cheese' && CHEESES.map((option) => <Chip key={option.id} on={build.cheese === option.id} onClick={() => send({ cheese: option.id })} note="Included">{option.label}</Chip>)}
            {step === 'toppings' && TOPPINGS.map((option) => {
              const on = build.toppings.includes(option.id)
              return (
                <Chip key={option.id} on={on} disabled={!on && build.toppings.length >= MAX_TOPPINGS} onClick={() => send(on ? { remove: [option.id] } : { add: [option.id] })}>
                  {option.label}
                </Chip>
              )
            })}
          </div>
          {step === 'base' && (
            <div className="build-chips build-chips-secondary">
              {CRUSTS.map((option) => (
                <Chip
                  key={option.id}
                  on={build.crust === option.id}
                  onClick={() => send({ crust: option.id })}
                  note={option.extra ? `+${formatPrice(priceFor(option.extra, option.id === 'gluten_free' ? 'small' : size).unitAmount)}${option.id === 'gluten_free' ? ' · small only' : ''}` : null}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
          )}
          {step === 'toppings' && (
            <div className="build-dock-actions">
              <span className="build-hint">{topping} each · up to {MAX_TOPPINGS}</span>
              <button className="build-bake" onClick={bake}>Bake it</button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Caption({ captions }) {
  const line = captions.live ?? captions.said.at(-1)
  if (!line) return null
  return (
    <div className="build-caption" data-speaker={line.speaker} data-live={Boolean(captions.live)}>
      <span className="caption-who">{line.speaker === 'customer' ? 'You' : 'Rocco\'s'}</span>
      <span>{line.text}</span>
    </div>
  )
}

// The latest change, popped above the pizza.
function ChangePop({ change }) {
  return (
    <div className="build-pop-wrap" aria-live="polite">
      <AnimatePresence>
        {change && (
          <motion.div
            key={change.seq}
            className="build-pop"
            initial={{ opacity: 0, y: 16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', duration: 0.45, bounce: 0.3 }}
          >
            {change.change}
            <span className="build-pop-rules">{change.rules.join(' · ')}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function BuildMode({ build, captions, dispatch }) {
  const [baked, setBaked] = useState(false)
  const [pop, setPop] = useState(null)

  useEffect(() => {
    if (!build.lastChange) return
    setPop(build.lastChange)
    const timer = setTimeout(() => setPop(null), 2200)
    return () => clearTimeout(timer)
  }, [build.lastChange?.seq])

  useEffect(() => {
    if (!baked) return
    const timer = setTimeout(() => dispatch({ type: 'build_done' }), 1500)
    return () => clearTimeout(timer)
  }, [baked, dispatch])

  const send = (change) => dispatch({ type: 'build', quote: null, ...change })
  const stage = baked ? 'baked' : build.stage

  return (
    <motion.div
      className="build"
      data-stage={stage}
      initial={{ clipPath: 'circle(0% at 50% 55%)' }}
      animate={{ clipPath: 'circle(150% at 50% 55%)', transition: { duration: 0.7, ease: [0.77, 0, 0.175, 1] } }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.35, ease: EASE_OUT } }}
    >
      <div className="build-glow" />
      <div className="build-canvas">
        <Suspense fallback={null}>
          <PizzaScene build={build} onBaked={() => setBaked(true)} />
        </Suspense>
      </div>

      <header className="build-top">
        <div className="build-brand">
          <span className="brand-name">Rocco's</span>
          <span className="build-kicker">Build your own</span>
        </div>
        <button className="build-close" onClick={() => dispatch({ type: 'build_cancel' })}>Back to menu</button>
      </header>

      <Steps build={build} />
      <Bill build={build} />
      <ChangePop change={pop} />

      {build.stage === 'building' ? (
        <Dock build={build} send={send} bake={() => dispatch({ type: 'build_bake', quote: null })} />
      ) : (
        <div className="build-oven">
          <AnimatePresence mode="wait">
            <motion.h2
              key={stage}
              className="build-prompt"
              initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease: EASE_OUT }}
            >
              {baked ? 'Fresh out of the oven' : 'Stone-baking at 400°'}
            </motion.h2>
          </AnimatePresence>
          <div className="build-oven-bar"><span /></div>
          <p className="build-hint">{baked ? 'Adding it to your order' : 'Every pound on this pizza is on the ticket, with what you said'}</p>
        </div>
      )}

      <Caption captions={captions} />
    </motion.div>
  )
}
