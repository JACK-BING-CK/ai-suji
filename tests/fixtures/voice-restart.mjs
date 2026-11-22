import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setImmediate as tick } from 'node:timers/promises'
import { useVoiceRecorder } from '../../src/services/voiceRecorder.ts'

// 新进程只带上次落盘的数据，不复用模块里的文件索引或上传 Promise。
const [dir, account] = process.argv.slice(2)
const storagePath = join(dir, 'storage.json')
const storage = JSON.parse(readFileSync(storagePath, 'utf8'))
globalThis.uni = {
  getStorageSync: (key) => storage[key],
  setStorageSync(key, value) {
    storage[key] = value
  },
  removeStorageSync(key) {
    delete storage[key]
  },
}
globalThis.plus = {
  os: { name: 'Android' },
  io: {
    resolveLocalFileSystemURL(path, done) {
      done({ isFile: true, remove: () => unlinkSync(path) })
    },
  },
}
const text = []
const uploaded = []
const page = useVoiceRecorder(
  {
    owner: () => account,
    onError: assert.fail,
    onTranscript: (value) => text.push(value),
  },
  async (path) => {
    uploaded.push({ path, bytes: readFileSync(path).toString('hex') })
    return '恢复后转写'
  },
)
page.show()
if (page.pending.value) await page.retry()
await tick()
writeFileSync(storagePath, JSON.stringify(storage))
process.stdout.write(
  JSON.stringify({ uploaded, text, pending: page.pending.value }),
)
