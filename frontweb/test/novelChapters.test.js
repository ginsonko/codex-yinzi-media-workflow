import test from 'node:test'
import assert from 'node:assert/strict'
import { joinSelectedChapters, splitNovelChapters } from '../src/utils/novelChapters.js'

test('splits Chinese and Markdown novel chapter headings and keeps selectable source text', () => {
  const chapters = splitNovelChapters(`序言文字\n\n第一章 星门\n林夏进入星门。\n\n## 第二章 花园\n她看见发光种子。`)
  assert.equal(chapters.length, 3)
  assert.equal(chapters[0].title, '正文')
  assert.match(chapters[1].title, /第一章/)
  assert.match(chapters[2].content, /发光种子/)
  const selected = joinSelectedChapters(chapters, [2, 3])
  assert.doesNotMatch(selected, /序言文字/)
  assert.match(selected, /星门/)
  assert.match(selected, /花园/)
})
