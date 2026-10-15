import { MENU_WORDS } from './menu'

const Words = ({ text, highlight }) => text.split(' ').map((word, index) => {
  const bare = word.toLowerCase().replace(/[^a-z']/g, '')
  return (
    <span key={index} className="word" data-menu={highlight && MENU_WORDS.has(bare)}>
      {word}{' '}
    </span>
  )
})

function CaptionLine({ line, live }) {
  const customer = line.speaker === 'customer'
  return (
    <p key={line.id} className="caption" data-speaker={line.speaker} data-live={live}>
      <span className="caption-who">{customer ? 'Customer' : 'Rocco\'s'}</span>
      <span className="caption-text">
        <Words text={line.text} highlight={customer} />
        {line.tag === 'blocked' && <span className="caption-tag">Not on the menu</span>}
      </span>
    </p>
  )
}

// Live mode: voice.ts state → button label. Calibrating = the ~1.5s room-noise check right after Start.
const MIC_LABEL = { calibrating: 'Hush…', speaking: 'Speaking', open: 'Listening', idle: 'Listening' }

export default function Captions({ captions, live }) {
  const lines = [...captions.said.slice(captions.live ? -1 : -2)]
  return (
    <footer className="captions">
      <div className="listening" data-on={live.on}>
        {live.button ? (
          <button className="mic-button" onClick={live.button} data-on={live.on} data-state={live.state}>
            <span className="listening-dot" />
            {live.on ? MIC_LABEL[live.state] ?? 'Listening' : 'Start mic'}
          </button>
        ) : (
          <>
            <span className="listening-dot" />
            Listening
          </>
        )}
      </div>
      <div className="caption-lines">
        {lines.map((line) => <CaptionLine key={line.id} line={line} live={false} />)}
        {captions.live && <CaptionLine key={captions.live.id} line={captions.live} live />}
      </div>
    </footer>
  )
}
