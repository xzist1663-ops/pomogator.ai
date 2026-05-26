import { parsePhotos, PhotoData } from './photos'

export interface ProductData {
  photos: PhotoData
}

export function parseProduct(): ProductData {
  return {
    photos: parsePhotos(),
  }
}