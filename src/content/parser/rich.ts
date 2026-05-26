export interface RichData {
  hasRich: boolean
  imageCount: number
}

export function parseRich(): RichData {
  // Rich-контент = фото/картинки внутри описания
  const descWidget = document.querySelector('[data-widget="webDescription"]')
  const images = descWidget?.querySelectorAll('img') || []
  const imageCount = images.length

  return {
    hasRich: imageCount > 0,
    imageCount,
  }
}