export interface AttributeData {
  raw: string
  count: number
  hasRequired: boolean
  filledNames: string[]
}

const REQUIRED_FIELDS = ['бренд', 'страна', 'материал', 'цвет', 'тип']

export function parseAttributes(): AttributeData {
  const terms = document.querySelectorAll(
    '[data-widget="webCharacteristics"] dt, [data-widget="webShortCharacteristics"] dt'
  )

  const filledNames: string[] = []
  terms.forEach(term => {
    const name = (term.textContent || '').trim().toLowerCase()
    if (name) filledNames.push(name)
  })

  const count = filledNames.length
  const hasRequired = REQUIRED_FIELDS.some(field =>
    filledNames.some(name => name.includes(field))
  )
  const raw = filledNames.join(' ')

  return { raw, count, hasRequired, filledNames }
}