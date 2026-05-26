export interface ReviewData {
  rating: number
  reviewCount: number
  hasPhotos: boolean
}

export function parseReviews(): ReviewData {
  // Рейтинг — берём из блока рядом с заголовком товара
  let rating = 0
  const headingBlock = document.querySelector('[data-widget="webProductHeading"]')?.parentElement
  const ratingMatch = headingBlock?.textContent?.match(/(\d)[.,](\d)/)
  if (ratingMatch) {
    rating = parseFloat(`${ratingMatch[1]}.${ratingMatch[2]}`)
  }

  // Количество отзывов — из виджета счёта отзывов
  let reviewCount = 0
  const scoreText = document.querySelector('[data-widget="webReviewProductScore"]')?.textContent || ''
  const countMatch = scoreText.match(/(\d[\d\s]*)\s*отзыв/i)
  if (countMatch) {
    reviewCount = parseInt(countMatch[1].replace(/\s/g, ''), 10)
  }

  // Фото в отзывах — ищем галерею фото от покупателей
  const hasPhotos = !!(
    document.querySelector('[data-widget="webReviewsGallery"]') ||
    document.querySelector('[data-widget="webGalleryReviews"]')
  )

  return { rating, reviewCount, hasPhotos }
}
