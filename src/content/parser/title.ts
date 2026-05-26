 import { extractKeywords } from '../../shared/utils/keywords'

export interface TitleData {
  text: string
  length: number
  hasBrand: boolean
  keywords: string[]
}

export function parseTitle(): TitleData {
  const text = (document.querySelector('h1')?.textContent || '').trim()
  const length = text.length

  // Бренд — ищем латиницу с заглавной буквы (Aqua, Sony и т.п.)
  const hasBrand = /[A-Z][a-z]+/.test(text)

  const keywords = extractKeywords(text, 3)

  return { text, length, hasBrand, keywords }
}
