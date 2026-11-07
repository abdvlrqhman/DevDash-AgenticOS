import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textDir } from './dir.ts'

test('a question reads right to left when its first letter is Arabic or Hebrew', () => {
  assert.equal(textDir('كيف تريد أن تعمل الإرادة الحرة؟'), 'rtl')
  assert.equal(textDir('1. «هل نبدأ؟» API'), 'rtl') // digits and punctuation first don't decide
  assert.equal(textDir('שלום'), 'rtl')
  assert.equal(textDir('Use React or Vue? (بالعربي)'), 'ltr')
  assert.equal(textDir(''), 'ltr')
})
