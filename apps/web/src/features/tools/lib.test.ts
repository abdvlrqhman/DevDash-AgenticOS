import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertBase, decodeBase64, decodeHtml, decodeUrl, describeCron, encodeBase64, encodeHtml, encodeUrl,
  jsonToQuery, jsonToYaml, nextCronRuns, parseColor, parseCron, queryToJson, rgbToHsl, slugify, toCase, toHex,
  transformLines, yamlToJson,
} from './lib.ts'

test('number base conversion round-trips across bases', () => {
  assert.equal(convertBase('255', 10, 16), 'ff')
  assert.equal(convertBase('ff', 16, 2), '11111111')
  assert.equal(convertBase('11111111', 2, 10), '255')
  assert.equal(convertBase('777', 8, 10), '511')
  assert.equal(convertBase('-42', 10, 16), '-2a')
  // Big integers beyond Number precision.
  assert.equal(convertBase('ffffffffffffffff', 16, 10), '18446744073709551615')
  assert.throws(() => convertBase('2', 2, 10), /valid digit/)
})

test('case converter handles every flavour', () => {
  assert.equal(toCase('hello world example', 'camel'), 'helloWorldExample')
  assert.equal(toCase('hello world example', 'pascal'), 'HelloWorldExample')
  assert.equal(toCase('hello world example', 'snake'), 'hello_world_example')
  assert.equal(toCase('hello world example', 'kebab'), 'hello-world-example')
  assert.equal(toCase('hello world example', 'constant'), 'HELLO_WORLD_EXAMPLE')
  assert.equal(toCase('hello world example', 'title'), 'Hello World Example')
  assert.equal(toCase('hello world example', 'dot'), 'hello.world.example')
  // Splits existing camelCase / kebab back into words.
  assert.equal(toCase('helloWorld-example', 'snake'), 'hello_world_example')
  assert.equal(toCase('XMLHttpRequest', 'kebab'), 'xml-http-request')
})

test('slugify produces clean URL slugs', () => {
  assert.equal(slugify('Hello, World! Café déjà vu'), 'hello-world-cafe-deja-vu')
  assert.equal(slugify('  spaced   out  '), 'spaced-out')
  assert.equal(slugify('under_scored text', '_'), 'under_scored_text')
  assert.equal(slugify('--leading & trailing--'), 'leading-trailing')
  assert.equal(slugify(''), '')
})

test('cron: plain-English description', () => {
  assert.match(describeCron('*/15 * * * *'), /Every 15 minutes/)
  assert.match(describeCron('* * * * *'), /^Every minute/)
  const weekday = describeCron('0 9 * * 1-5')
  assert.match(weekday, /At 09:00/)
  assert.match(weekday, /Monday/)
  assert.match(weekday, /Friday/)
  assert.match(describeCron('@daily'), /At 00:00/)
  assert.throws(() => parseCron('1 2 3'), /five fields/)
})

test('cron: next run times match the expression', () => {
  const runs = nextCronRuns(parseCron('30 2 * * *'), new Date('2025-01-01T00:00:00'), 3)
  assert.equal(runs.length, 3)
  for (const d of runs) { assert.equal(d.getHours(), 2); assert.equal(d.getMinutes(), 30) }
  assert.equal(runs[0]!.getDate(), 1)
  assert.equal(runs[1]!.getDate(), 2)

  const weekdays = nextCronRuns(parseCron('0 0 * * 1-5'), new Date('2025-01-04T00:00:00'), 2) // Jan 4 2025 is a Saturday
  assert.equal(weekdays[0]!.getDay(), 1) // next run is Monday
})

test('base64 round-trips unicode', () => {
  assert.equal(encodeBase64('Hello world'), 'SGVsbG8gd29ybGQ=')
  assert.equal(decodeBase64('SGVsbG8gd29ybGQ='), 'Hello world')
  const s = 'Café — 日本語 😀'
  assert.equal(decodeBase64(encodeBase64(s)), s)
  assert.equal(encodeBase64('ß', true).includes('='), false) // url-safe strips padding
})

test('url and html entity encode/decode', () => {
  assert.equal(encodeUrl('a b&c'), 'a%20b%26c')
  assert.equal(decodeUrl('a+b%26c'), 'a b&c')
  assert.equal(encodeHtml('<a href="x">T&J</a>'), '&lt;a href=&quot;x&quot;&gt;T&amp;J&lt;/a&gt;')
  assert.equal(decodeHtml('&lt;b&gt;&amp;#9;&#64;'), '<b>&#9;@')
})

test('YAML round-trips a nested structure', () => {
  const obj = { name: 'devdash', ports: [80, 443], nested: { enabled: true, ratio: 0.5 }, note: 'hi: there' }
  const yaml = jsonToYaml(obj)
  assert.deepEqual(yamlToJson(yaml), obj)
  assert.deepEqual(yamlToJson('a: 1\nb:\n  - x\n  - y\n'), { a: 1, b: ['x', 'y'] })
})

test('query string <-> JSON', () => {
  assert.deepEqual(queryToJson('?a=1&b=two&a=3'), { a: ['1', '3'], b: 'two' })
  assert.equal(jsonToQuery('{"a":1,"b":[2,3]}'), 'a=1&b=2&b=3')
})

test('colour parsing and conversion', () => {
  const blue = parseColor('#3b82f6')
  assert.deepEqual({ r: blue.r, g: blue.g, b: blue.b }, { r: 59, g: 130, b: 246 })
  assert.equal(toHex(blue), '#3b82f6')
  assert.deepEqual(rgbToHsl(parseColor('#ff0000')), { h: 0, s: 100, l: 50 })
  assert.deepEqual(parseColor('rgb(255 255 255)'), { r: 255, g: 255, b: 255, a: 1 })
  assert.throws(() => parseColor('nope'), /Unrecognised/)
})

test('line transforms: trim, dedup, sort', () => {
  assert.equal(transformLines('b\na\nb\n\n', { trim: true, dedup: true, removeEmpty: true, sort: 'asc' }), 'a\nb')
  assert.equal(transformLines('A\na', { dedup: true, caseInsensitive: true }), 'A')
})
