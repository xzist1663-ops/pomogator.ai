 export interface AttributeData {
  count: number
  hasRequired: boolean
  filledNames: string[]
}

// Обязательные поля которые ищем
const REQUIRED_FIELDS = ['бренд', 'страна', 'материал', 'цвет', 'тип']

export function parseAttributes(): AttributeData {
  // Ищем характеристики в обоих виджетах
  const terms = document.querySelectorAll(
    '[data-widget="webCharacteristics"] dt, [data-widget="webShortCharacteristics"] dt'
  )

  const filledNames: string[] = []
  terms.forEach(term => {
    const name = (term.textContent || '').trim().toLowerCase()
    if (name) filledNames.push(name)
  })

  const count = filledNames.length

  // Проверяем сколько обязательных полей заполнено
  const hasRequired = REQUIRED_FIELDS.some(field =>
    filledNames.some(name => name.includes(field))
  )

  return { count, hasRequired, filledNames }
}
