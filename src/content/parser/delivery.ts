 export interface DeliveryData {
  speedText: string
  speedDays: number
}

export function parseDelivery(): DeliveryData {
  const match = document.body.innerText.match(
    /(послезавтра|завтра|сегодня|(\d+)\s*(день|дня|дней))/i
  )

  let speedText = match?.[0] || 'неизвестно'
  let speedDays = 99

  if (/сегодня/i.test(speedText)) speedDays = 0
  else if (/завтра/i.test(speedText)) speedDays = 1
  else if (/послезавтра/i.test(speedText)) speedDays = 2
  else if (match?.[2]) speedDays = parseInt(match[2], 10)

  return { speedText, speedDays }
}
