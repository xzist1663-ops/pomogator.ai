import { config } from './config.js'

export interface ProductEconomics {
  offerId: string
  price: number
  commissionPercent: number
  commissionRub: number
  logistics: number
  cost: number | null
  net: number | null         // чистыми на единицу (без рекламы)
  marginPct: number | null
  light: 'green' | 'yellow' | 'red' | 'no_cost'
}

// Маржа на единицу = цена − комиссия − логистика − эквайринг − себестоимость.
// Реклама не учитывается здесь (она поартикульная, Phase 2 / Performance API).
export function computeEconomics(args: {
  offerId: string
  price: number
  commissionPercent: number
  logistics: number
  cost: number | null
}): ProductEconomics {
  const { offerId, price, commissionPercent, logistics, cost } = args
  const commissionRub = Math.round((price * commissionPercent) / 100)
  const acquiring = Math.round(price * 0.015)

  let net: number | null = null
  let marginPct: number | null = null
  let light: ProductEconomics['light'] = 'no_cost'

  if (cost != null) {
    net = Math.round(price - commissionRub - logistics - acquiring - cost)
    marginPct = price > 0 ? Math.round((net / price) * 100) : 0
    light =
      marginPct >= config.margin.green ? 'green'
      : marginPct >= config.margin.yellow ? 'yellow'
      : 'red'
  }

  return { offerId, price, commissionPercent, commissionRub, logistics, cost, net, marginPct, light }
}
