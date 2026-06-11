export interface PhotoData {
  count: number
  hasVideo: boolean
  hasVideoCover: boolean
  has360: boolean
}

export function parsePhotos(): PhotoData {
  const images = document.querySelectorAll('[data-widget="webGallery"] img')

  const uniqueIds = new Set<string>()
  images.forEach(img => {
    const src = (img as HTMLImageElement).src
    const match = src.match(/\/(\d+)\.jpg/)
    if (match) uniqueIds.add(match[1])
  })
  const count = uniqueIds.size

  const hasVideo = !!(
    document.querySelector('[data-widget="webGallery"] video') ||
    document.querySelector('[data-widget="webGallery"] [class*="video"]')
  )

  // Видеообложка — превью видео в галерее (src содержит /cover/)
  const galleryImgs = [...document.querySelectorAll<HTMLImageElement>('[data-widget="webGallery"] img')]
  const hasVideoCover = galleryImgs.some(img => img.src?.includes('/cover/'))

  const has360 = !!(
    document.querySelector('[class*="360"]') ||
    document.querySelector('[class*="panorama"]')
  )

  return { count, hasVideo, hasVideoCover, has360 }
}