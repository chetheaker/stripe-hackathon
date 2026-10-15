import { COURSES, formatPrice, formatShortPrice, itemsIn, liveLines, priceFor } from './menu'

const Chillies = ({ level }) => (level > 0 ? <span className="tag tag-chilli" title={`Chilli level ${level}`}>{'🌶'.repeat(level)}</span> : null)

const Dietary = ({ item }) => {
  if (item.dietary?.includes('vegan')) return <span className="tag tag-veg">Vegan</span>
  if (item.dietary?.includes('vegetarian')) return <span className="tag tag-veg">Veggie</span>
  return null
}

const CountBadge = ({ count }) => (count > 0 ? <span className="count-badge">{count}</span> : null)

function PizzaCard({ item, count, sizes, glow, onPick }) {
  return (
    <button className="pizza-card" data-item={item.id} data-glow={glow} data-in-order={count > 0} onClick={() => onPick(item)}>
      <div className="pizza-card-head">
        <h3>{item.name}</h3>
        <CountBadge count={count} />
      </div>
      <p className="pizza-desc">{item.description}</p>
      <div className="pizza-foot">
        <div className="pizza-tags">
          {item.popular && <span className="tag tag-popular">Popular</span>}
          <Dietary item={item} />
          <Chillies level={item.spiceLevel} />
        </div>
        <div className="pizza-prices">
          {item.prices.map((price) => (
            <span key={price.size} className="pizza-price" data-picked={sizes.has(price.size)}>
              <b>{price.size[0].toUpperCase()}</b>
              {formatPrice(price.unitAmount)}
            </span>
          ))}
        </div>
      </div>
    </button>
  )
}

const rowPrice = (item) => {
  if (item.prices.length === 1) return formatShortPrice(item.prices[0].unitAmount)
  return item.prices.map((price) => formatShortPrice(price.unitAmount)).join(' / ')
}

const rowDetail = (item) => {
  if (item.category === 'drink' && item.prices.length > 1) return 'can / 1.5L'
  if (item.id === 'chicken_wings') return '6 / 12'
  return null
}

function MenuRow({ item, count, glow, onPick }) {
  const detail = rowDetail(item)
  return (
    <button className="menu-row" data-item={item.id} data-glow={glow} data-in-order={count > 0} onClick={() => onPick(item)}>
      <span className="menu-row-name">
        {item.name}
        {detail && <small>{detail}</small>}
      </span>
      <CountBadge count={count} />
      <span className="menu-row-price">{rowPrice(item)}</span>
    </button>
  )
}

function BuildCard({ glow, onBuild }) {
  return (
    <button className="build-card" data-item="build_your_own" data-glow={glow} onClick={onBuild}>
      <div>
        <h3>Build your own</h3>
        <p>Any size, any sauce, up to 8 toppings</p>
      </div>
      <span className="build-card-say">Say “I want to make my own”</span>
      <span className="build-card-pizza" aria-hidden="true" />
    </button>
  )
}

export default function MenuBoard({ lines, glowItemId, spotlight, onPick, onBuild }) {
  const counts = {}
  const sizes = {}
  for (const line of liveLines(lines)) {
    counts[line.itemId] = (counts[line.itemId] ?? 0) + line.quantity
    ;(sizes[line.itemId] ??= new Set()).add(line.size)
  }

  const row = (item) => (
    <MenuRow key={item.id} item={item} count={counts[item.id] ?? 0} glow={glowItemId === item.id} onPick={onPick} />
  )

  return (
    <main className="board">
      <section className="board-section" data-spotlight={spotlight === 'pizza'}>
        <header className="section-head">
          <h2>Pizzas</h2>
          <p className="section-note">
            Stone-baked · Small 10" · Medium 12" · Large 14" · Extra topping from {formatPrice(priceFor('extra_topping', 'small').unitAmount)} · Stuffed crust from {formatPrice(priceFor('stuffed_crust', 'small').unitAmount)} · Gluten-free base (small) {formatPrice(priceFor('gluten_free_base', 'small').unitAmount)}
          </p>
        </header>
        <div className="pizza-grid">
          {itemsIn('pizza').map((item) => (
            <PizzaCard
              key={item.id}
              item={item}
              count={counts[item.id] ?? 0}
              sizes={sizes[item.id] ?? new Set()}
              glow={glowItemId === item.id}
              onPick={onPick}
            />
          ))}
          <BuildCard glow={glowItemId === 'build_your_own'} onBuild={onBuild} />
          <div className="deals-cell">
            <h3>Meal deals</h3>
            {itemsIn('meal_deal').map((item) => (
              <button key={item.id} className="menu-row deal-row" data-item={item.id} data-glow={glowItemId === item.id} data-in-order={(counts[item.id] ?? 0) > 0} onClick={() => onPick(item)} title={item.description}>
                <span className="menu-row-name">{item.name}</span>
                <CountBadge count={counts[item.id] ?? 0} />
                <span className="menu-row-price">{formatPrice(item.prices[0].unitAmount)}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="board-columns">
        {COURSES.filter(({ category }) => category !== 'pizza').map(({ category, title, nudge }) => (
          <section key={category} className="board-section board-column" data-spotlight={spotlight === category}>
            <header className="section-head">
              <h2>{title}</h2>
              <span className="spotlight-label">{nudge}</span>
            </header>
            <div className="menu-rows">{itemsIn(category).map(row)}</div>
          </section>
        ))}
      </div>
    </main>
  )
}
