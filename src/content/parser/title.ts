import { extractKeywords } from '../../shared/utils/keywords'

export interface TitleData {
  raw: string
  text: string
  length: number
  hasBrand: boolean
  keywords: string[]
}

export function parseTitle(): TitleData {
  const text = (document.querySelector('h1')?.textContent || '').trim()
  const length = text.length
  const hasBrand = /[A-Z][a-z]+/.test(text)
  const keywords = extractKeywords(text, 3)
  return { raw: text, text, length, hasBrand, keywords }
}