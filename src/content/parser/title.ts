import { extractKeywords } from '../../shared/utils/keywords'

export interface TitleData {
  raw: string
  text: string
  length: number
  hasBrand: boolean
  keywords: string[]
  productType: string
}

function parseBreadcrumbType(): string {
  const allCategoryLinks = Array.from(
    document.querySelectorAll('a[href*="/category/"]')
  )
  // Фильтруем подкатегории (c4d_7)
  const breadcrumbLinks = allCategoryLinks.filter(a =>
    a.className.includes('c4d_7')
  )
  // Берём ПРЕДПОСЛЕДНИЙ — последний часто бренд/продавец
  if (breadcrumbLinks.length >= 2) {
    const target = breadcrumbLinks[breadcrumbLinks.length - 2]
    const text = target.textContent?.trim() ?? ''
    if (text) return text
  }
  // Если только один — берём его
  if (breadcrumbLinks.length === 1) {
    const text = breadcrumbLinks[0].textContent?.trim() ?? ''
    if (text) return text
  }
  return ''
}

export function parseTitle(): TitleData {
  const text = (document.querySelector('h1')?.textContent || '').trim()
  const length = text.length
  const hasBrand = /[A-Z][a-z]+/.test(text)
  const keywords = extractKeywords(text, 3)
  const productType = parseBreadcrumbType()
  return { raw: text, text, length, hasBrand, keywords, productType }
}
