import { useCallback, useEffect, useRef, useState } from 'react'

import { isBuildRequest, parseBuildUtterance } from './build/buildModel'
import { BUILD_SCRIPT, DEMO_SCRIPT } from './demoScript'
import { ITEMS_BY_ID, defaultSize } from './menu'
import { bargeIn, initVoice, micOn as voiceMicOn, say as playSay, startMic, stopMic, stopSpeaking, unlockAudio } from '../shared/voice'

const params = new URLSearchParams(location.search)
export const IS_LIVE = params.has('live')
const SCRIPT = params.get('script') === 'build' ? BUILD_SCRIPT : DEMO_SCRIPT

const CUSTOMER_WORD_MS = 70
const AGENT_WORD_MS = 35
const EVENT_GAP_MS = 500

// Plays SCRIPT one step at a time: streams the words, applies the events, then the reply.
export const useDemoPlayer = (dispatch) => {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const timers = useRef([])

  const later = (ms, fn) => timers.current.push(setTimeout(fn, ms))
  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  const speak = (speaker, text, startAt, wordMs) => {
    const words = text.split(' ')
    words.forEach((_, index) => {
      later(startAt + index * wordMs, () => {
        dispatch({ type: 'utterance', speaker, text: words.slice(0, index + 1).join(' '), final: false })
      })
    })
    const endAt = startAt + words.length * wordMs
    later(endAt, () => dispatch({ type: 'utterance', speaker, text, final: true }))
    return endAt
  }

  const next = useCallback(() => {
    if (busy || step >= SCRIPT.length) return
    const current = SCRIPT[step]
    setBusy(true)
    let at = current.customer ? speak('customer', current.customer, 0, CUSTOMER_WORD_MS) + 250 : 0
    current.events.forEach((event, index) => {
      later(at + index * EVENT_GAP_MS, () => dispatch({ quote: current.customer ?? null, ...event }))
    })
    at += (current.events.length - 1) * EVENT_GAP_MS + (current.pause ?? 0)
    if (current.agent) at = speak('agent', current.agent, at + 700, AGENT_WORD_MS)
    later(at + 150, () => {
      setBusy(false)
      setStep((value) => value + 1)
    })
  }, [busy, step, dispatch])

  const reset = useCallback(() => {
    clearTimers()
    setBusy(false)
    setAuto(false)
    setStep(0)
    dispatch({ type: 'reset' })
  }, [dispatch])

  useEffect(() => {
    if (!auto || busy) return
    if (step >= SCRIPT.length) return setAuto(false)
    const timer = setTimeout(next, step === 0 ? 300 : 1300)
    return () => clearTimeout(timer)
  }, [auto, busy, step, next])

  useEffect(() => clearTimers, [])

  return { step, total: SCRIPT.length, busy, auto, setAuto, next, reset, label: SCRIPT[step]?.customer ?? SCRIPT[step]?.label }
}

/*
  Live mode (?live): talks to Che's server on /ws. The server sends whole-cart
  snapshots; we diff them into add / update / remove events so the screen can
  animate each change and keep the quote history.
*/
const cartKey = (line) => line.menu_id

/*
  Build your own runs on the screen: final transcripts are parsed here into
  build events, so it works whatever the server's cart agent does.
*/
export const useLiveFeed = (dispatch, buildRef) => {
  const socket = useRef(null)
  const previous = useRef(new Map())
  const [connected, setConnected] = useState(false)
  const [micOn, setMicOn] = useState(false)
  // Mic / kiosk audio state from web/shared/voice.ts: off | calibrating | idle | open | speaking
  const [voice, setVoice] = useState('off')
  // Server order status: ordering | awaiting_confirmation | awaiting_payment | paid
  const [status, setStatus] = useState('ordering')
  // The kiosk's spoken reply arrives one sentence per {type:'say'}; sentences of one turn share a caption.
  const agentLine = useRef(null) // { turn, text } while the current reply is still being spoken

  const send = useCallback((message) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
  }, [])

  const finishTimer = useRef(null)

  const finishAgentLine = useCallback(() => {
    clearTimeout(finishTimer.current)
    if (!agentLine.current) return
    dispatch({ type: 'utterance', speaker: 'agent', text: agentLine.current.text, final: true })
    agentLine.current = null
  }, [dispatch])

  useEffect(() => {
    if (!IS_LIVE) return
    let closed = false
    let retry

    const applyCart = (items) => {
      const next = new Map(items.map((line) => [cartKey(line), line]))
      for (const [key, line] of next) {
        const before = previous.current.get(key)
        const size = line.size ?? (ITEMS_BY_ID[line.menu_id] ? defaultSize(ITEMS_BY_ID[line.menu_id]) : undefined)
        if (!before) dispatch({ type: 'add', item: line.menu_id, size, quantity: line.qty, quote: line.quote })
        else if (before.qty !== line.qty || before.size !== line.size) {
          dispatch({ type: 'update', line: line.menu_id, quantity: line.qty, size: line.size, quote: line.quote })
        }
      }
      for (const [key, line] of previous.current) {
        if (!next.has(key)) dispatch({ type: 'remove', line: line.menu_id, quote: null })
      }
      previous.current = next
    }

    initVoice(send, (buffer) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(buffer)
    }, {
      dom: false,
      onState: (state) => {
        setVoice(state)
        // Settle the caption once the kiosk has been quiet a moment (sentences can arrive with small gaps).
        clearTimeout(finishTimer.current)
        if (state !== 'speaking' && state !== 'calibrating') finishTimer.current = setTimeout(finishAgentLine, 1500)
      },
    })

    const handle = (message) => {
      if (message.type === 'say') {
        // Show the words in Alex's captions (same 'utterance' events the demo uses) and queue the audio.
        const turn = message.turn ?? null
        const same = agentLine.current && turn != null && agentLine.current.turn === turn
        clearTimeout(finishTimer.current)
        if (!same) finishAgentLine()
        const text = same ? `${agentLine.current.text} ${message.text}` : message.text
        agentLine.current = { turn, text }
        dispatch({ type: 'utterance', speaker: 'agent', text, final: false })
        playSay(message)
      }
      if (message.type === 'stop_speaking') {
        stopSpeaking()
        finishAgentLine()
      }
      if (message.type === 'status') {
        setStatus(message.status)
        // Map onto the screen's phases: read-back → "please check"; back to ordering → editable again.
        if (message.status === 'awaiting_confirmation') dispatch({ type: 'confirm_request' })
        if (message.status === 'ordering') dispatch({ type: 'edit_again' })
      }
      if (message.type === 'transcript') {
        finishAgentLine()
        dispatch({ type: 'utterance', speaker: 'customer', text: message.text, final: message.final })
        if (message.final) {
          const build = buildRef?.current
          if (build) parseBuildUtterance(message.text, build).forEach(dispatch)
          else if (isBuildRequest(message.text)) dispatch({ type: 'build_open', quote: message.text })
        }
      }
      if (message.type === 'cart' && !buildRef?.current) applyCart(message.items)
      if (message.type === 'notice' || message.type === 'error') dispatch({ type: 'notice', text: message.text })
      if (message.type === 'checkout') dispatch({ type: 'checkout_ready', url: message.url })
      if (message.type === 'paid') dispatch({ type: 'paid' })
    }

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?bargein=${bargeIn ? 1 : 0}`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 1000)
      }
      ws.onmessage = (message) => handle(JSON.parse(message.data))
      socket.current = ws
    }
    connect()

    return () => {
      closed = true
      clearTimeout(retry)
      socket.current?.close()
      stopSpeaking()
      if (voiceMicOn()) stopMic()
    }
  }, [dispatch, send, finishAgentLine])

  // Mic button: 16 kHz PCM capture + noise gate + playback live in web/shared/voice.ts (same as /basic/).
  // The click unlocks audio playback and starts the ~1.5s room calibration (keep quiet), then the
  // server's opening greeting ({type:'hello'}).
  const toggleMic = useCallback(async () => {
    if (voiceMicOn()) {
      stopMic()
      setMicOn(false)
      return
    }
    unlockAudio()
    try {
      await startMic()
      send({ type: 'hello' })
      setMicOn(true)
    } catch (error) {
      dispatch({ type: 'notice', text: `Microphone unavailable: ${error.message}` })
    }
  }, [dispatch, send])

  const resetLive = useCallback(() => {
    previous.current = new Map()
    agentLine.current = null
    stopSpeaking()
    setStatus('ordering')
    send({ type: 'reset' })
  }, [send])

  return { connected, send, micOn, voice, status, toggleMic, resetLive }
}
