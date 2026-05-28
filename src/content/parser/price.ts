export interface PriceData {
  currentPrice: number
  oldPrice: number
  hasDiscount: boolean
  discountPercent: number
  promoType: string | null  // 'Распродажа' | 'Цена что надо' | 'Вау-цены' | null
}

export function parsePrice(): PriceData {
  const priceWidget = document.querySelector('[data-widget="webPrice"]')
  const priceText = priceWidget?.textContent || ''

  const prices = [...priceText.matchAll(/(\d[\d\s]*)\s*₽/g)]
    .map(m => parseInt(m[1].replace(/\s/g, ''), 10))
    .filter(p => p > 0)

  if (prices.length === 0) {
    return { currentPrice: 0, oldPrice: 0, hasDiscount: false, discountPercent: 0, promoType: null }
  }

  const currentPrice = Math.min(...prices)
  const oldPrice = Math.max(...prices)
  const hasDiscount = oldPrice > currentPrice
  const discountPercent = hasDiscount ? Math.round((1 - currentPrice / oldPrice) * 100) : 0

  // Парсим тип акции из бейджей на странице
  const pageText = document.body.innerText
  let promoType: string | null = null
  if (pageText.includes('Распродажа')) promoType = 'Распродажа'
  else if (pageText.includes('Вау-цены')) promoType = 'Вау-цены'
  else if (pageText.includes('Цена что надо')) promoType = 'Цена что надо'

  return { currentPrice, oldPrice, hasDiscount, discountPercent, promoType }
}