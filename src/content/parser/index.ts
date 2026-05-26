import { parsePhotos, PhotoData } from './photos'
import { parseAttributes, AttributeData } from './attributes'
import { parseReviews, ReviewData } from './reviews'

export interface ProductData {
  photos: PhotoData
  attributes: AttributeData
  reviews: ReviewData
}

export function parseProduct(): ProductData {
  return {
    photos: parsePhotos(),
    attributes: parseAttributes(),
    reviews: parseReviews(),
  }
}