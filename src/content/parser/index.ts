import { parsePhotos, PhotoData } from './photos'
import { parseAttributes, AttributeData } from './attributes'
import { parseReviews, ReviewData } from './reviews'
import { parseTitle, TitleData } from './title'
import { parseDelivery, DeliveryData } from './delivery'
import { parseDescription, DescriptionData } from './description'

export interface ProductData {
  photos: PhotoData
  attributes: AttributeData
  reviews: ReviewData
  title: TitleData
  delivery: DeliveryData
  description: DescriptionData
}

export function parseProduct(): ProductData {
  return {
    photos: parsePhotos(),
    attributes: parseAttributes(),
    reviews: parseReviews(),
    title: parseTitle(),
    delivery: parseDelivery(),
    description: parseDescription(),
  }
}