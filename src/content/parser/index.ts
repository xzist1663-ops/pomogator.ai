import { parsePhotos, PhotoData } from './photos'
import { parseAttributes, AttributeData } from './attributes'

export interface ProductData {
  photos: PhotoData
  attributes: AttributeData
}

export function parseProduct(): ProductData {
  return {
    photos: parsePhotos(),
    attributes: parseAttributes(),
  }
}