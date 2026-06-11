export interface DescriptionData {
  raw: string
  length: number
  hasText: boolean
}

export function parseDescription(): DescriptionData {
  const text = document.querySelector('[data-widget="webDescription"]')?.textContent || ''
  const trimmed = text.trim()
  return { raw: trimmed, length: trimmed.length, hasText: trimmed.length > 0 }
}