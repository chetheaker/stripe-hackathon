import { formatPrice } from './menu'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

// A price whose digits roll like an odometer when the total changes.
export default function RollingPrice({ amount }) {
  const text = formatPrice(amount)
  const characters = [...text]
  return (
    <span className="rolling" aria-label={text}>
      {characters.map((character, index) => {
        const key = characters.length - index
        if (!/\d/.test(character)) return <span key={key} aria-hidden="true">{character}</span>
        return (
          <span key={key} className="rolling-digit" aria-hidden="true">
            <span className="rolling-strip" style={{ transform: `translateY(-${Number(character) * 10}%)` }}>
              {DIGITS.map((digit) => <span key={digit}>{digit}</span>)}
            </span>
          </span>
        )
      })}
    </span>
  )
}
