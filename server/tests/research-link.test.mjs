import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import test from 'node:test'
import {
  canOpenMaterial,
  isDomesticMaterialUrl,
  webUrl,
} from '../src/research-link.ts'

test('原文可经跳转打开，已失效、无内容和循环跳转的来源被跳过', async (t) => {
  const pages = new Map([
    ['/article', [200]],
    ['/old', [301, '/article']],
    ['/gone', [410]],
    ['/empty', [204]],
    ['/cycle', [302, '/cycle']],
    ['/leaves-publisher', [302, 'https://other.example.org/article']],
  ])
  const seen = []
  t.mock.method(https, 'get', (url, options, respond) => {
    assert.equal(options.headers.Authorization, undefined)
    seen.push(url.pathname)
    const [statusCode, location] = pages.get(url.pathname)
    respond({ statusCode, headers: { location }, destroy() {} })
    return new EventEmitter()
  })
  const signal = new globalThis.AbortController().signal
  assert.equal(await canOpenMaterial('https://news.cctv.com/old', signal), true)
  assert.deepEqual(seen, ['/old', '/article'])
  for (const path of ['gone', 'empty', 'cycle', 'leaves-publisher'])
    assert.equal(
      await canOpenMaterial('https://news.cctv.com/' + path, signal),
      false,
    )
  assert.equal(seen.filter((path) => path === '/cycle').length, 4)
  assert.equal(seen.filter((path) => path === '/article').length, 1)
})

test('国内来源按发布机构完整域名匹配，链接必须为 HTTPS', () => {
  assert.ok(isDomesticMaterialUrl('https://www.gov.cn/article/1'))
  assert.ok(isDomesticMaterialUrl('https://news.cn/article/2'))
  for (const url of [
    'https://zh.wikipedia.org/wiki/敦煌',
    'https://cctv.com.example.org/a',
    'https://notcctv.com/a',
    'http://news.cctv.com/a',
    'https://cctv.com@other.example.cn/a',
  ])
    assert.equal(isDomesticMaterialUrl(url), false)
})

test('原文探测只接受标准公网网页地址', () => {
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'https://example.org:2222/',
    'file:///article',
  ]) {
    assert.equal(webUrl(url), null)
  }
  assert.equal(webUrl('https://example.org:443/article').pathname, '/article')
})
