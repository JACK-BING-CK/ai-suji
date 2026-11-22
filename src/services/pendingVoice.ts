import { computed, ref, shallowReactive } from 'vue'

export interface RecordingFile {
  path: string
  saved: boolean
  storing?: Promise<string>
  uploading?: Promise<string>
  transcript?: string
}
const files = shallowReactive(new Map<string, RecordingFile>())
const prefix = 'ai-suji.pending-voice.v1.'

function current(account: string): RecordingFile | undefined {
  const cached = files.get(account)
  if (cached) return cached
  const value: unknown = uni.getStorageSync(prefix + account)
  let entry: RecordingFile | undefined
  if (typeof value === 'string' && value) {
    // 兼容旧版本保存的持久文件路径。
    entry = { path: value, saved: true }
  } else if (
    value &&
    typeof value === 'object' &&
    'path' in value &&
    typeof value.path === 'string' &&
    value.path &&
    'saved' in value &&
    typeof value.saved === 'boolean'
  ) {
    entry = { path: value.path, saved: value.saved }
    if ('transcript' in value && typeof value.transcript === 'string')
      entry.transcript = value.transcript
  }
  if (entry) files.set(account, entry)
  return entry
}

function writeIndex(account: string, entry: RecordingFile) {
  const value =
    entry.saved && !entry.transcript
      ? entry.path
      : {
          path: entry.path,
          saved: entry.saved,
          ...(entry.transcript && { transcript: entry.transcript }),
        }
  uni.setStorageSync(prefix + account, value)
}

async function save(account: string, entry: RecordingFile) {
  try {
    const original = entry.path
    const saved = await new Promise<string>((resolve, reject) =>
      uni.saveFile({
        tempFilePath: original,
        success: (result) => resolve(result.savedFilePath),
        fail: reject,
      }),
    )
    if (files.get(account) !== entry) {
      if (saved !== original) discardFile(saved)
      throw new Error('录音已丢弃。')
    }
    entry.path = saved
    entry.saved = true
    writeIndex(account, entry)
    // App-Plus 的 saveFile 使用复制；持久索引提交成功后再清理原生录音副本。
    if (
      original !== saved &&
      /(?:^|\/)uniapp_temp_[^/]+\/recorder\//.test(original)
    )
      discardFile(original)
    return saved
  } catch (cause) {
    throw new Error('无法持久保存录音，请检查设备存储后重试。', { cause })
  }
}

function persist(account: string, entry: RecordingFile) {
  if (entry.saved) {
    writeIndex(account, entry)
    return Promise.resolve(entry.path)
  }
  entry.storing ??= save(account, entry).finally(() => {
    entry.storing = undefined
  })
  return entry.storing
}

// App-Plus 启动后会清理上一进程的临时目录，尽早恢复上次未完成的文件复制。
export async function recoverPendingVoice(account: string) {
  const entry = current(account)
  if (entry && !entry.saved) await persist(account, entry)
}

export function usePendingVoice(owner: () => string | undefined) {
  const accountOnPage = ref(owner())
  const pending = computed(
    () => !!accountOnPage.value && files.has(accountOnPage.value),
  )

  function restore() {
    accountOnPage.value = owner()
    if (accountOnPage.value) return current(accountOnPage.value)
  }

  async function keep(account: string, tempPath: string) {
    const entry: RecordingFile = { path: tempPath, saved: false }
    files.set(account, entry)
    // 即使原生复制尚未回调，重启时也能按原账号找到源文件。
    writeIndex(account, entry)
    await persist(account, entry)
    return entry
  }

  function transcribe(
    account: string,
    entry: RecordingFile,
    upload: (path: string) => Promise<string>,
  ) {
    if (entry.transcript) return Promise.resolve(entry.transcript)
    entry.uploading ??= upload(entry.path)
      .then((text) => {
        if (files.get(account) === entry) {
          entry.transcript = text
          // 页面暂离时先保存已返回的文字，重进后可直接回填。
          writeIndex(account, entry)
        }
        return text
      })
      .finally(() => {
        entry.uploading = undefined
      })
    return entry.uploading
  }

  function remove(account: string, path: string) {
    const entry = current(account)
    if (!entry || entry.path !== path) return
    uni.removeStorageSync(prefix + account)
    files.delete(account)
    discardFile(path)
  }

  return { pending, current, keep, persist, transcribe, remove, restore }
}

export function discardFile(path: string) {
  // App-Plus 两端的文件均位于应用私有目录。
  // #ifdef APP-PLUS
  const failed = () => console.warn('录音文件清理失败。')
  try {
    plus.io.resolveLocalFileSystemURL(
      path,
      (entry) => {
        if (entry.isFile) entry.remove(undefined, failed)
      },
      failed,
    )
  } catch {
    failed()
  }
  // #endif
}
