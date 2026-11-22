import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import process from 'node:process'
import test from 'node:test'
import { URL } from 'node:url'
import mysql from 'mysql2/promise'
import { createApp } from '../src/app.ts'
import { debugSmsProvider } from '../src/sms.ts'
import {
  extractKeywords,
  parseMaterials,
  searchSources,
  createResearchProviders,
} from '../src/research-model.ts'
import { createSearchProvider } from '../src/research-search.ts'

const source = {
  title: '城市树木',
  url: 'https://news.cctv.com/2026/11/01/ARTItree.shtml?b=%e6%a0%91&a=1#冠层',
  snippet: '城市树木通过树冠遮阴。',
  source_name: '央视网',
  published_at: 0,
}
const material = {
  title: source.title,
  url: source.url,
  summary: '树冠为城市遮阴。',
  source_name: source.source_name,
  published_at: 0,
}

test(
  'MySQL 素材、发布记录与共享额度，空结果和模型重试分别记账',
  {
    skip: process.env.AI_SUJI_MYSQL_TEST !== '1' && '需要独立 MySQL 测试库',
    timeout: 30000,
  },
  async (t) => {
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
    })
    const owners = []
    const ideaId = randomUUID()
    let mode = 'success'
    let searches = 0
    const modelCalls = []
    const deadUrl = 'https://news.cctv.com/removed-article'
    const code = randomUUID()
    const app = createApp({
      pool,
      jwtSecret: randomUUID(),
      smsProvider: debugSmsProvider(code),
      research: {
        async search() {
          searches++
          if (mode === 'unreachable') return [{ ...source, url: deadUrl }]
          return mode === 'empty' ? [] : [source]
        },
        async verifyLink(url) {
          return url !== deadUrl
        },
        async summarize(input, retry) {
          modelCalls.push(retry)
          const url = JSON.parse(input).results[0].url
          return {
            content:
              mode === 'retry' && !retry
                ? '['
                : JSON.stringify([{ ...material, url }]),
            model: 'test',
            tokens: 13,
          }
        },
      },
    })
    const server = app.listen(0, '127.0.0.1')
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      try {
        for (const owner of owners) {
          for (const table of [
            'material',
            'sync_publications',
            'idea',
            'usage_log',
          ])
            await pool.execute('DELETE FROM ' + table + ' WHERE user_id=?', [
              owner,
            ])
          await pool.execute('DELETE FROM `user` WHERE id=?', [owner])
        }
      } finally {
        await pool.end()
      }
    })
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + server.address().port + '/api/'
    async function call(path, body, token) {
      const response = await globalThis.fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: 'Bearer ' + token }),
        },
        body: JSON.stringify(body),
      })
      return response.json()
    }
    async function login() {
      const phone = '+999' + randomInt(100000000000, 999999999999)
      const result = await call('auth/login', { phone, code })
      assert.equal(result.code, 0, result.msg)
      owners.push(result.data.user.id)
      return result.data
    }
    const mine = await login()
    const other = await login()
    const owner = mine.user.id
    const search = (token) => call('ai/research', { idea_id: ideaId }, token)
    await pool.execute(
      'INSERT INTO idea (id,user_id,content,created_at,updated_at) VALUES (?,?,?,?,?)',
      [ideaId, owner, '城市绿地降温', 1, 1],
    )
    assert.equal((await search()).code, 401)
    assert.equal((await search(other.token)).code, 404)
    assert.equal(searches, 0)
    const first = await search(mine.token)
    assert.equal(first.code, 0, first.msg)
    assert.equal(first.data[0].url, source.url)
    for (const [key, value] of Object.entries(material))
      assert.equal(first.data[0][key], value)
    assert.equal((await search(mine.token)).data[0].id, first.data[0].id)
    const [pub] = await pool.execute(
      "SELECT record_id FROM sync_publications WHERE user_id=? AND table_name='material'",
      [owner],
    )
    assert.deepEqual(
      pub.map((x) => x.record_id),
      [first.data[0].id],
    )
    mode = 'retry'
    const before = searches
    assert.equal((await search(mine.token)).code, 0)
    assert.deepEqual(modelCalls.slice(-2), [false, true])
    assert.equal(searches - before, 3)
    mode = 'empty'
    assert.deepEqual((await search(mine.token)).data, [])
    mode = 'unreachable'
    const missing = await search(mine.token)
    assert.equal(missing.code, 0, missing.msg)
    assert.deepEqual(missing.data, [])
    const [preserved] = await pool.execute(
      'SELECT id,url,deleted_at FROM material WHERE user_id=? AND idea_id=?',
      [owner, ideaId],
    )
    assert.deepEqual(
      preserved.map((row) => [row.id, row.url, row.deleted_at]),
      [[first.data[0].id, source.url, null]],
    )
    const [usage] = await pool.execute(
      'SELECT type,tokens FROM usage_log WHERE user_id=?',
      [owner],
    )
    assert.equal(usage.length, 6)
    assert.equal(
      usage.filter((x) => x.tokens === 13 && x.type === 'research').length,
      5,
    )
    assert.equal(
      usage.filter((x) => x.tokens === 0 && x.type === 'research').length,
      1,
    )
    await pool.execute(
      'UPDATE material SET deleted_at=2 WHERE user_id=? AND id=?',
      [owner, first.data[0].id],
    )
    mode = 'success'
    assert.deepEqual((await search(mine.token)).data, [])
    const now = Date.now()
    for (let i = 7; i < 20; i++)
      await pool.execute(
        'INSERT INTO usage_log (id,user_id,type,tokens,created_at,updated_at) VALUES (?,?,?,0,?,?)',
        [randomUUID(), owner, i % 2 ? 'expand' : 'breakdown', now, now],
      )
    const countBefore = searches
    assert.equal((await search(mine.token)).code, 42901)
    assert.equal(searches, countBefore)
  },
)

test('从长短想法提取不同检索词，每词仅取前五条并按原始链接去重', async () => {
  for (const idea of [
    '猫',
    '想研究城市绿地与降温措施',
    'community garden',
    '绿地绿地绿地',
  ]) {
    const keywords = extractKeywords(idea)
    assert.ok(keywords.length >= 3 && keywords.length <= 5)
    assert.equal(new Set(keywords).size, keywords.length)
  }
  const calls = []
  const hits = await searchSources(
    '城市绿地与降温',
    async (word) => {
      calls.push(word)
      return [
        source,
        ...Array.from({ length: 6 }, (_, i) => ({
          ...source,
          url: `https://example.org/${word}/${i}`,
        })),
      ]
    },
    new globalThis.AbortController().signal,
  )
  assert.deepEqual(calls, extractKeywords('城市绿地与降温'))
  assert.equal(hits.size, 1 + 4 * calls.length)
  assert.ok(hits.has(source.url))
  assert.ok(![...hits.keys()].some((url) => url.endsWith('/4')))
})

test('央视公开搜索从图文卡读取原始 HTTPS 链接、摘要和北京时间', async (t) => {
  const requests = []
  let body = '<h3 class="tit">抱歉，没有找到“树木”的相关网页结果</h3>'
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: new URL(url), init })
    return new globalThis.Response(body, {
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    })
  })
  const search = createSearchProvider({})
  const signal = new globalThis.AbortController().signal
  assert.deepEqual(await search('树木', signal), [])
  const { url, init } = requests[0]
  assert.equal(url.origin + url.pathname, 'https://search.cctv.com/search.php')
  assert.equal(url.searchParams.get('qtext'), '树木')
  assert.equal(url.searchParams.get('type'), 'web')
  assert.equal(init.headers['X-Subscription-Token'], undefined)

  function card(id, url, time = '') {
    return `<li class="image"><div class="tright"><h3 class="tit">
      <span lanmu1="${url.replaceAll('&', '&amp;')}" lanmu3="web_normal">
      <!-- <a id="web_content_" href=""></a> -->
      <a id="web_content_${id}" href="link_p.php?point=web_normal">城市<font color="red">树木</font></a>
      </span></h3><p class="bre"><img src="/image.jpg">城市<font color="red">树木</font>通过树冠遮阴。</p>
      <div class="src-tim"><span class="src">来源：新闻</span>
      <span class="tim">发布时间：${time}</span></div></div></li>`
  }
  const urls = [
    source.url,
    ...Array.from(
      { length: 6 },
      (_, i) => `https://news.cctv.com/2026/11/01/ARTI${i}.shtml`,
    ),
  ]
  body =
    '<div class="lmdhd"><span>全部网页结果共7条</span></div><ul>' +
    urls
      .map((url, i) => card(i, url, i === 0 ? '2024-04-16 12:30:00' : ''))
      .join('') +
    '</ul>'
  const rows = await search('树木', signal)
  assert.deepEqual(
    rows.map((row) => row.url),
    urls.slice(0, 5),
  )
  assert.deepEqual(rows[0], {
    ...source,
    published_at: Date.parse('2024-04-16T12:30:00+08:00'),
  })
  assert.equal(rows[1].published_at, 0)

  body =
    '<ul>' +
    [
      card(0, 'http://news.cctv.com/2026/11/01/ARTIold.shtml'),
      card(1, 'https://cctv.com.example.org/2026/11/01/ARTIforeign.shtml'),
      card(2, urls[1]).replace(
        /<p class="bre">.*?<\/p>/,
        '<p class="bre"></p>',
      ),
    ].join('') +
    '</ul>'
  assert.deepEqual(await search('树木', signal), [])
  body = '<html><h1>系统维护中</h1></html>'
  await assert.rejects(search('树木', signal))
})

test('配置 Brave 时只返回国内站原始链接，区分服务限流和空结果', async (t) => {
  let body
  let status = 200
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init })
    return new globalThis.Response(JSON.stringify(body), { status })
  })
  const signal = new globalThis.AbortController().signal
  const key = randomUUID()
  const brave = createSearchProvider({ SEARCH_API_KEY: key })
  body = {}
  assert.deepEqual(await brave('树木', signal), [])
  const hit = {
    url: source.url,
    title: source.title,
    description: source.snippet,
    profile: { name: source.source_name },
    page_age: '2024-04-16T12:30:00',
  }
  body = { web: { results: [hit] } }
  const found = await brave('树木', signal)
  assert.equal(found[0].url, source.url)
  assert.equal(found[0].published_at, Date.parse('2024-04-16T12:30:00Z'))
  assert.equal(requests.at(-1).url.hostname, 'api.search.brave.com')
  assert.equal(requests.at(-1).url.searchParams.get('count'), '5')
  assert.match(requests.at(-1).url.searchParams.get('q'), /site:cctv\.com/)
  assert.match(requests.at(-1).url.searchParams.get('q'), /树木/)
  assert.equal(requests.at(-1).init.headers['X-Subscription-Token'], key)
  for (const url of [
    'javascript:alert(1)',
    'https://user:pass@example.org/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://example.org/\u0000bad',
    'https://www.wikipedia.org/树木',
    'https://cctv.com.example.org/',
    'http://news.cctv.com/old',
    'https://[2606:4700:4700::1111]/',
    'https://8.8.8.8/',
  ]) {
    body = { web: { results: [{ ...hit, url }] } }
    assert.deepEqual(await brave('树木', signal), [])
  }
  status = 429
  await assert.rejects(brave('树木', signal), /限流/)
})

test('模型摘要逐条核对原文 URL、标题、日期和来源，拒绝编造或修改链接', async (t) => {
  const candidates = new Map([[source.url, source]])
  const decode = (arr) => parseMaterials(JSON.stringify(arr), candidates)
  assert.deepEqual(decode([material]), [material])
  assert.deepEqual(decode([]), [])
  for (const patch of [
    { url: 'https://example.org/new' },
    { url: source.url.replace('%e6', '%E6') },
    { source_name: '别处' },
    { published_at: 1 },
    { summary: '   ' },
    { title: '伪造的标题' },
  ]) {
    assert.throws(() => decode([{ ...material, ...patch }]))
  }
  assert.throws(() => decode([material, material]))
  const six = Array.from({ length: 6 }, (_, i) => ({
    ...material,
    url: source.url + i,
  }))
  assert.throws(() =>
    parseMaterials(
      JSON.stringify(six),
      new Map(six.map((m) => [m.url, { ...source, url: m.url }])),
    ),
  )
  assert.throws(() => parseMaterials('invalid', candidates))
  const prompts = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages[0].content)
    return new globalThis.Response(
      JSON.stringify({
        choices: [{ message: { content: '[]' } }],
        usage: { total_tokens: 12 },
      }),
    )
  })
  const model = createResearchProviders({
    LLM_API_KEY: randomUUID(),
    LLM_BASE_URL: 'http://127.0.0.1/v1',
  })
  assert.equal((await model.summarize('{}', false)).tokens, 12)
  await model.summarize('{}', true)
  assert.match(
    prompts[0],
    /摘要只能基于搜索返回内容，url 原样保留，禁止编造链接/,
  )
  assert.notEqual(prompts[0], prompts[1])
})
