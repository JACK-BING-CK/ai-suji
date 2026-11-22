import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  createExpandModel,
  isExpandTemplate,
  parseExpansion,
} from '../src/expand-model.ts'

const fields = {
  background: '背景',
  points: ['要点'],
  risks: '风险',
  next_steps: '下一步',
}

test('扩写只接受完整 JSON 对象和非空字段', () => {
  assert.deepEqual(
    parseExpansion(JSON.stringify({ ...fields, points: [' 要点 '] })),
    fields,
  )
  for (const input of [
    '无效 JSON',
    '[]',
    '{}',
    JSON.stringify({ ...fields, risks: ' ' }),
    JSON.stringify({ ...fields, extra: '多余字段' }),
    ...[[], [''], ['有效', 42], '单个要点'].map((points) =>
      JSON.stringify({ ...fields, points }),
    ),
  ])
    assert.throws(() => parseExpansion(input), /模型/)
  assert.equal(isExpandTemplate('constructor'), false)
  assert.equal(isExpandTemplate(null), false)
  assert.equal(createExpandModel({ LLM_API_KEY: randomUUID() }), undefined)
})

test('按模板调用兼容接口，回填模型及用量，故障不透露供应商响应', async (t) => {
  const key = randomUUID()
  let reply = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(fields) } }],
    model: 'served-model',
    usage: { total_tokens: 24 },
  })
  let status = 200
  const requests = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    requests.push({
      body: JSON.parse(text),
      url: req.url,
      authenticated: req.headers.authorization === 'Bearer ' + key,
    })
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(reply)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const model = createExpandModel({
    LLM_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1/',
    LLM_API_KEY: key,
    LLM_MODEL: 'requested-model',
  })
  const original = '想用阳台的香草做晚餐'
  for (const template of ['article', 'video', 'product', 'study', 'general']) {
    assert.ok(isExpandTemplate(template))
    const result = await model(original, template, false)
    assert.deepEqual(parseExpansion(result.content), fields)
    assert.equal(result.tokens, 24)
    assert.equal(result.model, 'served-model')
  }
  const prompts = new Set()
  for (const { body, url, authenticated } of requests) {
    assert.equal(url, '/v1/chat/completions')
    assert.ok(authenticated)
    assert.equal(body.model, 'requested-model')
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.equal(body.messages[0].role, 'system')
    assert.ok(!body.messages[0].content.includes(original))
    prompts.add(body.messages[0].content)
    assert.deepEqual(body.messages[1], { role: 'user', content: original })
  }
  assert.equal(prompts.size, 5)
  reply = 'invalid'
  const malformed = await model(original, 'general', true)
  assert.throws(() => parseExpansion(malformed.content), /JSON/)
  assert.notEqual(
    requests.at(-1).body.messages[0].content,
    requests[4].body.messages[0].content,
  )
  for (const [upstreamStatus, reason, expected] of [
    [429, { code: 'insufficient_quota' }, /余额不足/],
    [429, { type: 'billing_hard_limit_reached' }, /消费上限/],
    [402, {}, /余额不足/],
    [429, { code: 'rate_limit_exceeded' }, /暂时限流/],
    [429, null, /暂时限流/],
    [401, { code: 'invalid_api_key' }, /鉴权失败/],
    [403, { code: 'invalid_api_key' }, /鉴权失败/],
    [403, { code: 'model_access_denied' }, /无权访问/],
    [404, { code: 'model_not_found' }, /模型名称和访问权限/],
    [503, null, /未能完成请求/],
  ]) {
    status = upstreamStatus
    reply = reason
      ? JSON.stringify({ error: { ...reason, message: key + original } })
      : key + original
    await assert.rejects(
      model(original, 'general', false),
      (error) =>
        error.status === 500 &&
        error.code === 500 &&
        expected.test(error.message) &&
        !error.message.includes(key) &&
        !error.message.includes(original),
    )
  }
  await assert.rejects(
    model(original, 'general', false, globalThis.AbortSignal.abort()),
    /超时/,
  )
})
