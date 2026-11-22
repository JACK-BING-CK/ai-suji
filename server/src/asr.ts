import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Pool } from 'mysql2/promise'
import multer from 'multer'
import { parseBuffer } from 'music-metadata'
import CodecParser, { type CodecFrame } from 'codec-parser'
import { nonemptyText, object } from './chat-model.js'
import { HttpError } from './errors.js'

const maxBytes = 25 * 1024 * 1024
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 0, parts: 2, fileSize: maxBytes },
}).single('audio')

interface Recording {
  buffer: Buffer
  extension: string
  mime: string
}
export type TranscribeAudio = (
  file: Recording,
) => Promise<{ text: string; tokens: number }>

export function createTranscriber(
  env: NodeJS.ProcessEnv,
  send: typeof fetch = fetch,
): TranscribeAudio | undefined {
  const base = URL.parse(env.LLM_BASE_URL || '')
  const key =
    env.ASR_API_KEY?.trim() ||
    (base?.origin === 'https://api.openai.com' && env.LLM_API_KEY?.trim())
  if (!key) return undefined
  const model = env.ASR_MODEL?.trim() || 'gpt-4o-mini-transcribe'
  return async (file) => {
    const signal = AbortSignal.timeout(13_000)
    try {
      const form = new FormData()
      form.set(
        'file',
        new Blob([Uint8Array.from(file.buffer)], { type: file.mime }),
        'voice.' + file.extension,
      )
      form.set('model', model)
      form.set('response_format', 'json')
      const response = await send(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { Authorization: 'Bearer ' + key },
          body: form,
        },
      )
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const code = object(body) && object(body.error) ? body.error.code : null
        if (code === 'insufficient_quota' || response.status === 402)
          throw new HttpError(503, '语音识别服务额度不足，请检查后端账户余额。')
        if (response.status === 401 || response.status === 403)
          throw new HttpError(
            503,
            '语音识别服务鉴权失败，请检查后端密钥及权限。',
          )
        if (response.status === 429)
          throw new HttpError(503, '语音识别服务繁忙，请稍后重试。')
        throw new HttpError(
          502,
          '语音识别服务未能处理录音，请检查服务配置或稍后重试。',
        )
      }
      if (!object(body) || !nonemptyText(body.text))
        throw new HttpError(422, '未识别到文字，请确认录音中有清晰的人声。')
      const count = object(body.usage) ? body.usage.total_tokens : undefined
      return {
        text: body.text.trim(),
        tokens:
          typeof count === 'number' &&
          Number.isInteger(count) &&
          count >= 0 &&
          count <= 2147483647
            ? count
            : 0,
      }
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(
        503,
        signal.aborted
          ? '语音识别超时，请稍后重试。'
          : '无法连接语音识别服务，请稍后重试。',
      )
    }
  }
}

function checkDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new HttpError(400, '录音文件无效，请重新录音。')
  if (Math.round(seconds * 1_000_000) > 60_000_000)
    throw new HttpError(400, '单段录音最长 60 秒。')
}

function pcmSeconds(bytes: Buffer) {
  if (bytes.length < 44 || bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw new Error('WAV 长度无效')
  let bytesPerSecond = 0
  let soundBytes = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const data = offset + 8
    if (data + length > bytes.length) throw new Error('WAV 块不完整')
    if (tag === 'fmt ') {
      if (length < 16 || bytesPerSecond || bytes.readUInt16LE(data) !== 1)
        throw new Error('WAV 编码无效')
      const channels = bytes.readUInt16LE(data + 2)
      const rate = bytes.readUInt32LE(data + 4)
      const block = channels * Math.ceil(bytes.readUInt16LE(data + 14) / 8)
      bytesPerSecond = block * rate
      if (
        !block ||
        block !== bytes.readUInt16LE(data + 12) ||
        bytesPerSecond !== bytes.readUInt32LE(data + 8)
      )
        throw new Error('WAV 采样参数无效')
    }
    if (tag === 'data') soundBytes += length
    offset = data + length + (length & 1)
  }
  // 依据 PCM 数据量计算，不信任可选的 fact 帧数或上传方声明的时长。
  return soundBytes / bytesPerSecond
}

async function readRecording(bytes: Buffer): Promise<Recording> {
  try {
    if (
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
    ) {
      checkDuration(pcmSeconds(bytes))
      return { buffer: bytes, extension: 'wav', mime: 'audio/wav' }
    }
    // 原生上传可能使用通用 MIME，按音频数据检测实际编码及播放时长。
    const { format } = await parseBuffer(bytes, undefined, {
      duration: false,
      skipCovers: true,
      maxMemoryAllocation: 5 * 1024 * 1024,
    })
    if (!format.numberOfChannels || !format.sampleRate)
      throw new HttpError(400, '录音文件无效，请重新录音。')
    if (format.container === 'MPEG' && /Layer 3$/i.test(format.codec || '')) {
      // VBR 文件头的估算时长可能失真。逐帧累加播放时长，包含结尾帧。
      const parser = new CodecParser<CodecFrame>('audio/mpeg', {
        enableFrameCRC32: false,
      })
      let milliseconds = 0
      function count(frames: Iterator<CodecFrame>) {
        for (let next = frames.next(); !next.done; next = frames.next()) {
          milliseconds += next.value.duration
          checkDuration(milliseconds / 1000)
        }
      }
      for (let offset = 0; offset < bytes.length; offset += 65536)
        count(parser.parseChunk(bytes.subarray(offset, offset + 65536)))
      count(parser.flush())
      checkDuration(milliseconds / 1000)
      return { buffer: bytes, extension: 'mp3', mime: 'audio/mpeg' }
    }
    throw new HttpError(400, '请上传手机录制的 MP3 或 WAV 音频。')
  } catch (cause) {
    if (cause instanceof HttpError) throw cause
    throw new HttpError(400, '无法读取录音，请重新录音。')
  }
}

export function createAsrRouter(pool: Pool, transcribe?: TranscribeAudio) {
  const router = Router()
  router.post(
    '/',
    (request, response, next) => {
      upload(request, response, (cause: unknown) => {
        if (!cause) return next()
        next(
          cause instanceof multer.MulterError &&
            cause.code === 'LIMIT_FILE_SIZE'
            ? new HttpError(413, '录音文件过大，请缩短后再试。')
            : new HttpError(400, '请通过 audio 字段上传一段录音。'),
        )
      })
    },
    async (request, response, next) => {
      try {
        if (!request.file?.size)
          throw new HttpError(400, '录音为空，请重新录音。')
        const file = await readRecording(request.file.buffer)
        if (!transcribe) throw new HttpError(503, '后端尚未配置语音识别服务。')
        const owner: string = response.locals.userId
        const id = randomUUID()
        const now = Date.now()
        // 记录实际发出的调用。ASR 不读取也不占用扩写、拆解、搜索的每日额度。
        await pool.execute(
          "INSERT INTO usage_log (id,user_id,type,tokens,created_at,updated_at) VALUES (?,?,'asr',0,?,?)",
          [id, owner, now, now],
        )
        const { text, tokens } = await transcribe(file)
        await pool.execute(
          'UPDATE usage_log SET tokens = ?, updated_at = GREATEST(updated_at, ?) WHERE user_id = ? AND id = ?',
          [tokens, Date.now(), owner, id],
        )
        response.json({ code: 0, msg: '', data: { text } })
      } catch (cause) {
        next(cause)
      }
    },
  )
  return router
}
