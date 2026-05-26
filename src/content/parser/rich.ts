 export interface RichData {
  hasRich: boolean
  blockCount: number
}

export function parseRich(): RichData {
  const richBlocks = document.querySelectorAll('[data-widget="richTextWidget"]')
  const blockCount = richBlocks.length
  return {
    hasRich: blockCount > 0,
    blockCount,
  }
}
