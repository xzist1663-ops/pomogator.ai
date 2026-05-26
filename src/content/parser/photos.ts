export interface PhotoData {
  count: number
  hasVideo: boolean
  has360: boolean
  hasInfographic: boolean
}

export function parsePhotos(): PhotoData {
  const images = document.querySelectorAll('[data-widget="webGallery"] img')

  // Считаем уникальные фото по ID, игнорируя размер (wc50 vs wc1000)
  const uniqueIds = new Set<string>()
  images.forEach(img => {
    const src = (img as HTMLImageElement).src
    // Извлекаем ID фото — число перед .jpg
    const match = src.match(/\/(\d+)\.jpg/)
    if (match) {
      uniqueIds.add(match[1])
    }
  })
  const count = uniqueIds.size

  const hasVideo = !!(
    document.querySelector('[data-widget="webGallery"] video') ||
    document.querySelector('[data-widget="webGallery"] [class*="video"]')
  )

  const has360 = !!(
    document.querySelector('[class*="360"]') ||
    document.querySelector('[class*="panorama"]')
  )

  const allImages = document.querySelectorAll('[data-widget="webGallery"] img')
  let hasInfographic = false
  allImages.forEach(img => {
    const alt = img.getAttribute('alt') || ''
    if (alt.length > 30 || alt.toLowerCase().includes('инфографик')) {
      hasInfographic = true
    }
  })

  return { count, hasVideo, has360, hasInfographic }
}