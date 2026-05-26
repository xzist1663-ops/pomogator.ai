 export interface DescriptionData {
  length: number
  hasText: boolean
}

export function parseDescription(): DescriptionData {
  const text = document.querySelector('[data-widget="webDescription"]')?.textContent || ''
  const length = text.trim().length
  return { length, hasText: length > 0 }
}
