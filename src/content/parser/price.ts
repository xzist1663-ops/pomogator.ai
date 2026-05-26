 export interface PriceData {
  currentPrice: number
  oldPrice: number
  hasDiscount: boolean
  discountPercent: number
}

export function parsePrice(): PriceData {
  const priceText = document.querySelector('[data-widget="webPrice"]')?.textContent || ''
  
  // Все цены на странице (числа перед ₽)
  const prices = [...priceText.matchAll(/(\d[\d\s]*)\s*₽/g)]
    .map(m => parseInt(m[1].replace(/\s/g, ''), 10))
    .filter(p => p > 0)

  if (prices.length === 0) {
    return { currentPrice: 0, oldPrice: 0, hasDiscount: false, discountPercent: 0 }
  }

  // Текущая цена — минимальная, старая — максимальная
  const currentPrice = Math.min(...prices)
  const oldPrice = Math.max(...prices)
  const hasDiscount = oldPrice > currentPrice
  const discountPercent = hasDiscount
    ? Math.round((1 - currentPrice / oldPrice) * 100)
    : 0

  return { currentPrice, oldPrice, hasDiscount, discountPercent }
}
