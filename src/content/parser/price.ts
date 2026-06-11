export interface PriceData {
  currentPrice: number      // цена покупателя (с банком-партнёром / карта Ozon)
  basePrice: number         // цена без скидки банка — база для налогов
  hasDiscount: boolean
  discountPercent: number
  promoType: string | null
}

export function parsePrice(): PriceData {
  const widget = document.querySelector('[data-widget="webPrice"]')
  const text = widget?.textContent ?? ''

  // Извлекаем все цены из текста: "17 674 ₽  С банками  19 315 ₽  С другими банками"
  const allPrices = (text.match(/[\d\s]+(?=\s*₽)/g) ?? [])
    .map(p => parseInt(p.replace(/\s/g, '')))
    .filter(p => p > 0 && p < 10_000_000)

  // currentPrice = первая (меньшая, со скидкой банка)
  // basePrice = вторая (без скидки банка) — база для налогов
  const currentPrice = allPrices[0] ?? 0
  const basePrice    = allPrices[1] ?? allPrices[0] ?? 0  // если одна цена — берём её

  // Скидка: ищем зачёркнутую цену или процент скидки
  const discountMatch = text.match(/(\d+)\s*%/)
  const discountPercent = discountMatch ? parseInt(discountMatch[1]) : 0
  const hasDiscount = discountPercent > 0

  // Тип акции/плашки
  const promoEl = widget?.querySelector('[data-widget="webBadge"], [class*="badge"], [class*="promo"]')
  let promoType: string | null = null
  const promoText = promoEl?.textContent?.trim() ?? ''
  if (promoText && promoText.length < 40) promoType = promoText

  // Проверяем плашки "Цена что надо", "Вау-цены", "Распродажа"
  const allText = widget?.parentElement?.textContent ?? ''
  if (!promoType) {
    if (allText.includes('Цена что надо')) promoType = 'Цена что надо'
    else if (allText.includes('Вау-цен')) promoType = 'Вау-цены'
    else if (allText.includes('Распродажа')) promoType = 'Распродажа'
  }

  return { currentPrice, basePrice, hasDiscount, discountPercent, promoType }
}
