const CHAPTER_LINE = /^(?:#{1,3}\s*)?(第[零〇一二三四五六七八九十百千万两0-9]+[章节回卷幕]|chapter\s+\d+)\s*([^\n]*)$/i

export function splitNovelChapters(text, maxChapters = 200) {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []
  const lines = source.split('\n')
  const chapters = []
  let current = null
  for (const line of lines) {
    const heading = line.trim().match(CHAPTER_LINE)
    if (heading && chapters.length < maxChapters) {
      if (current && current.content.trim()) chapters.push({ ...current, content: current.content.trim() })
      current = {
        index: chapters.length + 1,
        title: [heading[1], heading[2]].filter(Boolean).join(' ').trim(),
        content: '',
      }
      continue
    }
    if (!current) current = { index: 1, title: '正文', content: '' }
    current.content += `${line}\n`
  }
  if (current?.content.trim()) chapters.push({ ...current, content: current.content.trim() })
  return chapters.slice(0, maxChapters).map((chapter, index) => ({ ...chapter, index: index + 1 }))
}

export function joinSelectedChapters(chapters, selectedIndexes) {
  const selected = new Set((selectedIndexes || []).map(Number))
  return (chapters || [])
    .filter((chapter) => selected.has(Number(chapter.index)))
    .map((chapter) => `${chapter.title}\n${chapter.content}`)
    .join('\n\n')
    .trim()
}
