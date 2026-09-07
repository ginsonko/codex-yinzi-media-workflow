import test from 'node:test'
import assert from 'node:assert/strict'
import { isSystemManagedTemplateStyle, resolveTemplateStyle } from '../src/utils/templateStyleOwnership.js'

const templates = [
  { id: 'image-to-video', defaults: { style: '图片模板默认' } },
  { id: 'ecommerce', defaults: { style: '电商模板默认' } },
]

test('switches a restored old template default to the selected template default', () => {
  assert.equal(resolveTemplateStyle({ currentStyle: '图片模板默认', targetStyle: '电商模板默认', templates, baseStyle: '通用默认' }), '电商模板默认')
})

test('preserves a true user-authored style', () => {
  assert.equal(resolveTemplateStyle({ currentStyle: '用户自定义柔光风格', targetStyle: '电商模板默认', templates, baseStyle: '通用默认' }), '用户自定义柔光风格')
  assert.equal(isSystemManagedTemplateStyle('用户自定义柔光风格', templates, '通用默认'), false)
})

test('uses the template default for empty or generic managed values', () => {
  assert.equal(resolveTemplateStyle({ currentStyle: '', targetStyle: '电商模板默认', templates, baseStyle: '通用默认' }), '电商模板默认')
  assert.equal(resolveTemplateStyle({ currentStyle: '通用默认', targetStyle: '电商模板默认', templates, baseStyle: '通用默认' }), '电商模板默认')
})
