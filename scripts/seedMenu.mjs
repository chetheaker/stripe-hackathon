import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MENU, RESTAURANT } from './menuData.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY_RUN = process.argv.includes('--dry-run')

const loadSecretKey = () => {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY
  const envPath = join(ROOT, '.env')
  if (!existsSync(envPath)) return undefined
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((envLine) => envLine.startsWith('STRIPE_SECRET_KEY='))
  return line?.slice('STRIPE_SECRET_KEY='.length).trim().replace(/^["']|["']$/g, '')
}

const lookupKeyFor = (item, price) => `${item.id}_${price.size}`

const createStripeClient = (secretKey) => {
  const request = async (method, path, params) => {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
    })
    const json = await response.json()
    if (!response.ok) throw new Error(`${method} ${path}: ${json.error?.message ?? response.status}`)
    return json
  }

  const listAll = async (path) => {
    const results = []
    let startingAfter
    do {
      const query = new URLSearchParams({ limit: '100', ...(startingAfter ? { starting_after: startingAfter } : {}) })
      const page = await request('GET', `${path}${path.includes('?') ? '&' : '?'}${query}`)
      results.push(...page.data)
      startingAfter = page.has_more ? page.data.at(-1).id : undefined
    } while (startingAfter)
    return results
  }

  return { request, listAll }
}

const productParams = (item) => ({
  name: item.name,
  description: item.description,
  active: 'true',
  'metadata[menu_id]': item.id,
  'metadata[category]': item.category,
})

const productNeedsUpdate = (product, item) =>
  !product.active ||
  product.name !== item.name ||
  product.description !== item.description ||
  product.metadata.category !== item.category

const seed = async (stripe) => {
  const products = await stripe.listAll('/products')
  const menuProductsById = new Map(
    products.filter((product) => product.metadata.menu_id).map((product) => [product.metadata.menu_id, product])
  )
  const activePrices = await stripe.listAll('/prices?active=true')
  const activePricesByLookupKey = new Map(
    activePrices.filter((price) => price.lookup_key).map((price) => [price.lookup_key, price])
  )

  const summary = { created: 0, updated: 0, archived: 0, unchanged: 0 }
  const seededItems = []
  const wantedLookupKeys = new Set()

  for (const item of MENU) {
    const existingProduct = menuProductsById.get(item.id)
    let product = existingProduct
    if (!existingProduct) {
      product = await stripe.request('POST', '/products', productParams(item))
      summary.created += 1
    } else if (productNeedsUpdate(existingProduct, item)) {
      product = await stripe.request('POST', `/products/${existingProduct.id}`, productParams(item))
      summary.updated += 1
    }

    const prices = []
    for (const price of item.prices) {
      const lookupKey = lookupKeyFor(item, price)
      wantedLookupKeys.add(lookupKey)
      const existingPrice = activePricesByLookupKey.get(lookupKey)
      const reusable =
        existingPrice &&
        existingPrice.unit_amount === price.unitAmount &&
        existingPrice.currency === RESTAURANT.currency &&
        existingPrice.product === product.id

      let stripePrice = existingPrice
      if (reusable) {
        summary.unchanged += 1
      } else {
        stripePrice = await stripe.request('POST', '/prices', {
          product: product.id,
          currency: RESTAURANT.currency,
          unit_amount: String(price.unitAmount),
          lookup_key: lookupKey,
          transfer_lookup_key: 'true',
          nickname: `${item.name} (${price.label})`,
          'metadata[menu_id]': item.id,
          'metadata[size]': price.size,
        })
        summary.created += 1
        if (existingPrice) {
          await stripe.request('POST', `/prices/${existingPrice.id}`, { active: 'false' })
          summary.archived += 1
        }
      }
      prices.push({ ...price, lookupKey, priceId: stripePrice.id })
    }

    seededItems.push({ ...item, productId: product.id, prices })
  }

  const menuProductIds = new Set([...menuProductsById.values()].map((product) => product.id))
  for (const price of activePrices) {
    if (menuProductIds.has(price.product) && !wantedLookupKeys.has(price.lookup_key)) {
      await stripe.request('POST', `/prices/${price.id}`, { active: 'false' })
      summary.archived += 1
    }
  }

  const wantedMenuIds = new Set(MENU.map((item) => item.id))
  for (const [menuId, product] of menuProductsById) {
    if (!wantedMenuIds.has(menuId) && product.active) {
      await stripe.request('POST', `/products/${product.id}`, { active: 'false' })
      summary.archived += 1
    }
  }

  return { seededItems, summary }
}

const main = async () => {
  if (DRY_RUN) {
    const items = MENU.map((item) => ({
      ...item,
      prices: item.prices.map((price) => ({ ...price, lookupKey: lookupKeyFor(item, price) })),
    }))
    console.log(JSON.stringify({ restaurant: RESTAURANT, items }, null, 2))
    return
  }

  const secretKey = loadSecretKey()
  if (!secretKey) throw new Error('Set STRIPE_SECRET_KEY in .env (a sk_test_ key)')
  if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key')

  const { seededItems, summary } = await seed(createStripeClient(secretKey))

  const outputPath = join(ROOT, 'menu.json')
  writeFileSync(outputPath, `${JSON.stringify({ restaurant: RESTAURANT, items: seededItems }, null, 2)}\n`)
  console.log(
    `${seededItems.length} menu items. Created ${summary.created}, updated ${summary.updated}, archived ${summary.archived}, unchanged ${summary.unchanged}.`
  )
  console.log(`Wrote ${outputPath}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
