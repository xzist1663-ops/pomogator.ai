export interface ReviewData {
  rating: number
  reviewCount: number
  hasPhotos: boolean
  hasVideos: boolean
}

// Виджеты с галереей медиа из отзывов (полоска фото/видео вверху страницы отзывов)
const GALLERY_WIDGETS = [
  '[data-widget="webReviewsGallery"]',
  '[data-widget="webGalleryReviews"]',
  '[data-widget="webReviewMediaGallery"]',
]

// Виджеты со списком отзывов (карточки отзывов)
const REVIEW_LIST_WIDGETS = [
  '[data-widget="webReviewList"]',
  '[data-widget="webReviews"]',
]

function queryAny(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el) return el
  }
  return null
}

// Проверяем, является ли img реальным фото отзыва (не иконка/аватар)
function isReviewPhoto(img: HTMLImageElement): boolean {
  const src = img.getAttribute('src') || img.src || ''
  if (!src || src.startsWith('data:')) return false
  // Пропускаем маленькие технические изображения
  const w = img.getAttribute('width')
  const h = img.getAttribute('height')
  if (w && parseInt(w) < 40) return false
  if (h && parseInt(h) < 40) return false
  return true
}

export function parseReviews(): ReviewData {
  // Рейтинг — из блока рядом с заголовком товара
  let rating = 0
  const headingBlock = document.querySelector('[data-widget="webProductHeading"]')?.parentElement
  const ratingMatch = headingBlock?.textContent?.match(/(\d)[.,](\d)/)
  if (ratingMatch) {
    rating = parseFloat(`${ratingMatch[1]}.${ratingMatch[2]}`)
  }
  // Fallback: из виджета рейтинга на странице отзывов
  if (!rating) {
    const scoreEl = document.querySelector('[data-widget="webReviewProductScore"]')
    const m = scoreEl?.textContent?.match(/(\d)[.,](\d)/)
    if (m) rating = parseFloat(`${m[1]}.${m[2]}`)
  }

  // Количество отзывов
  let reviewCount = 0
  const scoreText = document.querySelector('[data-widget="webReviewProductScore"]')?.textContent || ''
  const countMatch = scoreText.match(/(\d[\d\s]*)\s*отзыв/i)
  if (countMatch) {
    reviewCount = parseInt(countMatch[1].replace(/\s/g, ''), 10)
  }

  // Фото в отзывах:
  // 1. Галерея медиа вверху страницы отзывов — показывается только при наличии фото/видео
  const hasGallery = !!queryAny(GALLERY_WIDGETS)
  // 2. img внутри карточек отзывов (webReviewList — основной виджет на /reviews/)
  let hasImgsInCards = false
  for (const sel of REVIEW_LIST_WIDGETS) {
    const widget = document.querySelector(sel)
    if (!widget) continue
    const imgs = widget.querySelectorAll<HTMLImageElement>('img')
    if ([...imgs].some(isReviewPhoto)) { hasImgsInCards = true; break }
  }
  const hasPhotos = hasGallery || hasImgsInCards

  // Видео в отзывах:
  // webReviewList — список отзывов на странице /reviews/
  // webReviews — блок отзывов на странице товара
  // Галерея тоже может содержать video
  const videoSelectors = [
    ...REVIEW_LIST_WIDGETS.map(w => `${w} video`),
    ...REVIEW_LIST_WIDGETS.map(w => `${w} source[type*="video"]`),
    ...GALLERY_WIDGETS.map(w => `${w} video`),
    ...GALLERY_WIDGETS.map(w => `${w} source[type*="video"]`),
  ]
  const hasVideos = videoSelectors.some(sel => !!document.querySelector(sel))

  return { rating, reviewCount, hasPhotos, hasVideos }
}
