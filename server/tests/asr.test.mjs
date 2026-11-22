import assert from 'node:assert/strict'
import { Blob, Buffer } from 'node:buffer'
import test from 'node:test'
import { startApi } from './fixtures/api.mjs'
import { createTranscriber } from '../src/asr.ts'

function recording(seconds) {
  const size = 8000 * seconds
  const wav = Buffer.alloc(44 + size, 128)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + size, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(8000, 28)
  wav.writeUInt16LE(1, 32)
  wav.writeUInt16LE(8, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(size, 40)
  return wav
}

async function upload(url, token, bytes) {
  const body = new globalThis.FormData()
  body.append('audio', new Blob([bytes]), 'voice')
  return globalThis.fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body,
  })
}

function mp3(frames) {
  // MPEG-2 Layer III，16 kHz，32 kbps。写入失真的 Xing 时长，检查实际帧数。
  const frame = Buffer.alloc(144)
  frame.set([0xff, 0xf3, 0x48, 0xc0])
  const data = Buffer.concat(Array.from({ length: frames }, () => frame))
  data.write('Xing', 13)
  data.writeUInt32BE(1, 17)
  data.writeUInt32BE(2, 21)
  return data
}

test('鉴权、按音频内容校验 60 秒、ASR 独立记账及上游真实请求格式', async (t) => {
  const formats = []
  const subscriber = createTranscriber(
    { ASR_API_KEY: 'test-only' },
    async (url, init) => {
      assert.equal(
        String(url),
        'https://api.openai.com/v1/audio/transcriptions',
      )
      assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe')
      const attached = init.body.get('file')
      formats.push([attached.name, attached.type])
      assert.ok(attached.size > 0)
      return globalThis.Response.json({
        text: '整理采访素材',
        usage: { total_tokens: 12 },
      })
    },
  )
  const { base, login, usage } = await startApi(t, { asrModel: subscriber })
  const url = base + '/api/asr'
  const session = await login('13900000002')
  assert.equal(session.status, 200)
  const {
    data: { token, user },
  } = await session.json()
  for (const seconds of [1, 60]) {
    const res = await upload(url, token, recording(seconds))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      code: 0,
      msg: '',
      data: { text: '整理采访素材' },
    })
  }
  assert.equal((await upload(url, token, mp3(48))).status, 200)
  for (const bytes of [
    recording(61),
    mp3(1700),
    Buffer.alloc(0),
    Buffer.from('invalid'),
  ]) {
    const res = await upload(url, token, bytes)
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, 400)
  }
  assert.equal(
    (await upload(url, token, Buffer.alloc(25 * 1024 * 1024 + 1))).status,
    413,
  )
  assert.equal((await upload(url, null, recording(1))).status, 401)
  assert.equal((await upload(url, 'invalid', recording(1))).status, 401)
  assert.deepEqual(formats, [
    ['voice.wav', 'audio/wav'],
    ['voice.wav', 'audio/wav'],
    ['voice.mp3', 'audio/mpeg'],
  ])
  assert.equal(usage.length, 3)
  assert.ok(
    usage.every(
      (row) =>
        row.user_id === user.id && row.type === 'asr' && row.tokens === 12,
    ),
  )
})

test('适配器复用官方账户时不向其他服务传凭据，服务失败给出可读提示', async () => {
  assert.equal(
    createTranscriber({
      LLM_BASE_URL: 'https://example.net/v1',
      LLM_API_KEY: 'example',
    }),
    undefined,
  )
  const denied = createTranscriber(
    { LLM_BASE_URL: 'https://api.openai.com/v1', LLM_API_KEY: 'test-only' },
    async () =>
      globalThis.Response.json(
        {
          error: {
            code: 'insufficient_quota',
            message: 'private upstream details',
          },
        },
        { status: 429 },
      ),
  )
  await assert.rejects(
    denied({ buffer: recording(1), mime: 'audio/wav', extension: 'wav' }),
    /语音识别服务额度不足/,
  )
})
