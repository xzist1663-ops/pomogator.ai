export interface DeliveryData {
  speedText: string
  speedDays: number
  hasExpress: boolean
}

export function parseDelivery(): DeliveryData {
  // Берём срок из кнопки "В корзину" — там чистый текст
  const cartText = document.querySelector('[data-widget="webAddToCart"]')?.textContent || ''
  
  let speedText = 'неизвестно'
  let speedDays = 99

  if (/сегодня/i.test(cartText)) {
    speedText = 'Сегодня'
    speedDays = 0
  } else if (/завтра/i.test(cartText) && !/послезавтра/i.test(cartText)) {
    speedText = 'Завтра'
    speedDays = 1
  } else if (/послезавтра/i.test(cartText)) {
    speedText = 'Послезавтра'
    speedDays = 2
  } else {
    const match = cartText.match(/(\d+)\s*(день|дня|дней)/i)
    if (match) {
      speedDays = parseInt(match[1], 10)
      speedText = `${speedDays} дн.`
    }
  }

  const hasExpress = /экспресс|express/i.test(document.body.textContent || '')

  return { speedText, speedDays, hasExpress }
}