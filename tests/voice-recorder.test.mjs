import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { useVoiceRecorder } from '../src/services/voiceRecorder.ts'

// 停止请求和系统实际返回文件分开推进，覆盖退出页面时原生桥迟到的情况。
function recordingBridge(t) {
  const dir = mkdtempSync(join(tmpdir(), 'suji-voice-recovery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storage = new Map()
  const account = randomUUID()
  const bytes = randomBytes(256)
  const temp = join(dir, 'capture.mp3')
  const saved = join(dir, 'saved.mp3')
  let onStop
  const manager = {
    start() {
      writeFileSync(temp, bytes)
    },
    stop() {},
    onStop(fn) {
      onStop = fn
    },
    onError() {},
  }
  globalThis.plus = {
    os: { name: 'Android' },
    io: {
      resolveLocalFileSystemURL(path, done) {
        done({ isFile: true, remove: () => unlinkSync(path) })
      },
    },
  }
  globalThis.uni = {
    getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'authorized' }),
    getRecorderManager: () => manager,
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    saveFile({ tempFilePath, success }) {
      renameSync(tempFilePath, saved)
      success({ savedFilePath: saved })
    },
  }
  return {
    dir,
    storage,
    account,
    bytes,
    saved,
    finish: () => onStop({ tempFilePath: temp }),
  }
}

function coldStart(bridge) {
  const fixture = fileURLToPath(
    new URL('./fixtures/voice-restart.mjs', import.meta.url),
  )
  const storagePath = join(bridge.dir, 'storage.json')
  if (!existsSync(storagePath)) {
    writeFileSync(
      storagePath,
      JSON.stringify(Object.fromEntries(bridge.storage)),
    )
  }
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--import', 'tsx', fixture, bridge.dir, bridge.account],
      { encoding: 'utf8' },
    ),
  )
}

test('首次拒绝授权后引导设置，取消、录音错误后可以重新按住', async () => {
  let permissionCallback
  let permission = 'denied'
  let nativeStop
  let nativeError
  let starts = 0
  let stops = 0
  const dialogs = []
  const deleted = []
  const errors = []
  let settings = 0
  globalThis.plus = {
    os: { name: 'Android' },
    android: {
      requestPermissions: (_permissions, done) => {
        permissionCallback = done
      },
    },
    io: {
      resolveLocalFileSystemURL: (path, done) =>
        done({ isFile: true, remove: () => deleted.push(path) }),
    },
  }
  globalThis.uni = {
    getStorageSync: () => '',
    getAppAuthorizeSetting: () => ({ microphoneAuthorized: permission }),
    showToast: () => {},
    showModal: async (dialog) => {
      dialogs.push(dialog)
      return { confirm: true }
    },
    openAppAuthorizeSetting: async () => {
      settings++
    },
    getRecorderManager: () => ({
      onStop: (callback) => {
        nativeStop = callback
      },
      onError: (callback) => {
        nativeError = callback
      },
      start: (options) => {
        assert.ok(options.duration > 59000 && options.duration <= 60000)
        starts++
      },
      stop: () => {
        stops++
      },
    }),
  }
  const recorder = useVoiceRecorder({
    owner: () => 'permission-test',
    onTranscript: () => assert.fail('取消的录音不能回填'),
    onError: (message) => errors.push(message),
  })
  const denied = recorder.start()
  recorder.interruptTouch()
  recorder.hide(true)
  permissionCallback({ granted: [] })
  await tick()
  assert.equal(dialogs.length, 0)
  recorder.show()
  await denied
  assert.equal(starts, 0)
  assert.equal(dialogs.length, 1)
  assert.equal(settings, 1)
  assert.equal(recorder.phase.value, 'idle')

  const navigated = recorder.start()
  recorder.hide(false)
  permissionCallback({ granted: [] })
  recorder.show()
  await navigated
  assert.equal(dialogs.length, 1)

  const switchedOwner = recorder.start()
  recorder.hide(true)
  permissionCallback({ granted: [] })
  await tick()
  recorder.cancel()
  recorder.show()
  await switchedOwner
  assert.equal(dialogs.length, 1)

  permission = 'authorized'
  const cancelled = recorder.start()
  await tick()
  assert.equal(recorder.phase.value, 'recording')
  recorder.cancel()
  nativeStop({ tempFilePath: '/temporary/first.mp3' })
  await cancelled
  assert.deepEqual(deleted, ['/temporary/first.mp3'])
  assert.deepEqual(errors, [])

  const failed = recorder.start()
  await tick()
  nativeError()
  await failed
  assert.match(errors[0], /麦克风/)
  assert.equal(recorder.phase.value, 'idle')
  assert.equal(starts, 2)
  assert.equal(stops, 2)

  const capped = recorder.start()
  await tick()
  nativeStop({ tempFilePath: '/temporary/capped.mp3' })
  await tick()
  assert.equal(recorder.phase.value, 'recording')
  recorder.cancel()
  await capped
  assert.deepEqual(deleted, ['/temporary/first.mp3', '/temporary/capped.mp3'])
})

test('iOS 首次授权打断手势后需要重新按住，离开页面后的拒权结果忽略', async () => {
  let status = 'not determined'
  let callback
  const toasts = []
  globalThis.plus = {
    os: { name: 'iOS' },
    ios: {
      importClass: () => ({
        sharedInstance: () => ({
          requestRecordPermission: (done) => {
            callback = done
          },
        }),
      }),
    },
  }
  globalThis.uni = {
    getStorageSync: () => '',
    getAppAuthorizeSetting: () => ({ microphoneAuthorized: status }),
    showToast: (options) => toasts.push(options.title),
    showModal: () => assert.fail('离开页面后不能提示权限'),
  }
  const recorder = useVoiceRecorder({
    owner: () => 'ios-test',
    onError: assert.fail,
    onTranscript: assert.fail,
  })
  const granted = recorder.start()
  recorder.interruptTouch()
  status = 'authorized'
  callback()
  await granted
  assert.match(toasts[0], /重新按住/)
  assert.equal(recorder.phase.value, 'idle')

  status = 'not determined'
  const stale = recorder.start()
  recorder.cancel()
  status = 'denied'
  callback()
  await stale
  assert.equal(recorder.phase.value, 'idle')
})

test('弱网上传失败保留录音，切换账号隔离，重新转写后可编辑并保存为语音想法', async (t) => {
  const { createPinia } = await import('pinia')
  const { useDraftStore } = await import('../src/store/draft.ts')
  const { saveDraft, listInbox } = await import('../src/services/record.ts')
  const { installBridge } = await import('./fixtures/sqlite-bridge.mjs')
  const { randomUUID } = await import('node:crypto')
  const {
    mkdtempSync,
    readFileSync,
    renameSync,
    existsSync,
    writeFileSync,
    unlinkSync,
    rmSync,
  } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ai-suji-recording-'))
  const temporary = join(root, 'temporary.mp3'),
    saved = join(root, 'saved.mp3')
  writeFileSync(temporary, '录音文件')
  const connection = installBridge(join(root, 'ideas.db'))
  t.after(() => {
    connection()?.close()
    rmSync(root, { recursive: true, force: true })
  })
  const storage = new Map()
  let stopCallback
  Object.assign(globalThis.plus, {
    os: { name: 'Android' },
    io: {
      resolveLocalFileSystemURL: (path, done) =>
        done({ isFile: true, remove: () => unlinkSync(path) }),
    },
  })
  Object.assign(globalThis.uni, {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'authorized' }),
    saveFile: ({ tempFilePath, success }) => {
      renameSync(tempFilePath, saved)
      success({ savedFilePath: saved })
    },
    getRecorderManager: () => ({
      start() {},
      stop() {
        stopCallback({ tempFilePath: temporary })
      },
      onStop(fn) {
        stopCallback = fn
      },
      onError() {},
    }),
  })
  const draft = useDraftStore(createPinia()),
    account = randomUUID()
  draft.edit('已输入的草稿')
  let owner = account,
    uploads = 0
  const errors = []
  const options = {
    owner: () => owner,
    onError: (m) => errors.push(m),
    onTranscript: (t) => draft.appendTranscript(t),
  }
  const upload = async (path) => {
    assert.equal(readFileSync(path, 'utf8'), '录音文件')
    if (++uploads === 1) throw new Error('网络连接失败，请重试。')
    return '整理采访素材'
  }
  const first = useVoiceRecorder(options, upload)
  const recording = first.start()
  await tick()
  first.release()
  await recording
  assert.equal(first.pending.value, true)
  assert.match(errors[0], /网络/)
  assert.deepEqual([...storage.values()], [saved])
  assert.equal(existsSync(saved), true)
  assert.equal(draft.text, '已输入的草稿')
  owner = randomUUID()
  first.cancel()
  assert.equal(first.pending.value, false)
  owner = account
  const second = useVoiceRecorder(options, upload)
  second.show()
  assert.equal(second.pending.value, true)
  await second.retry()
  assert.equal(uploads, 2)
  assert.equal(existsSync(saved), false)
  assert.equal(second.pending.value, false)
  assert.equal(storage.size, 0)
  assert.equal(draft.text, '已输入的草稿\n整理采访素材')
  draft.edit(draft.text + '，明天发布。')
  await saveDraft(account, draft.text, draft.source)
  const [idea] = await listInbox(account)
  assert.equal(idea.source, 'voice')
  assert.equal(idea.content, '已输入的草稿\n整理采访素材，明天发布。')
})

test('松手后立即切到后台，原生迟到的录音文件仍可恢复，且不会写入其他账号', async () => {
  const storage = new Map()
  let onStop
  let owner = 'background-owner'
  globalThis.plus = { os: { name: 'Android' } }
  globalThis.uni = {
    getAppAuthorizeSetting: () => ({ microphoneAuthorized: 'authorized' }),
    getRecorderManager: () => ({
      start() {},
      stop() {},
      onStop(fn) {
        onStop = fn
      },
      onError() {},
    }),
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    saveFile: ({ success }) =>
      success({ savedFilePath: '/saved/background.mp3' }),
  }
  const recorder = useVoiceRecorder(
    { owner: () => owner, onTranscript: assert.fail, onError: assert.fail },
    assert.fail,
  )
  const captured = recorder.start()
  await tick()
  recorder.release()
  recorder.hide(true)
  owner = 'another-account'
  recorder.cancel()
  onStop({ tempFilePath: '/temp/background.mp3' })
  await captured
  assert.equal(recorder.pending.value, false)
  assert.equal(
    storage.get('ai-suji.pending-voice.v1.background-owner'),
    '/saved/background.mp3',
  )
  owner = 'background-owner'
  recorder.show()
  assert.equal(recorder.pending.value, true)
})

for (const interrupted of [false, true]) {
  test(`按住期间${interrupted ? '系统手势打断后' : ''}退页，新页先恢复、原生后返回也能找回这段录音`, async (t) => {
    const bridge = recordingBridge(t)
    const uploads = []
    const errors = []
    const options = {
      owner: () => bridge.account,
      onTranscript: assert.fail,
      onError: (msg) => errors.push(msg),
    }
    const offline = async (path) => {
      uploads.push(path)
      throw new Error('网络未连接')
    }
    const oldPage = useVoiceRecorder(options, offline)
    oldPage.show()
    const capture = oldPage.start()
    await tick()
    assert.equal(oldPage.phase.value, 'recording')
    if (interrupted) oldPage.interruptTouch()
    oldPage.hide(false)
    oldPage.cancel()
    const newPage = useVoiceRecorder(options, offline)
    newPage.show()
    bridge.finish()
    await capture
    await tick()
    assert.deepEqual(uploads, [])
    assert.equal(newPage.pending.value, true)
    assert.deepEqual(readFileSync(bridge.saved), bridge.bytes)
    await newPage.retry()
    assert.deepEqual(uploads, [bridge.saved])
    assert.match(errors.at(-1), /网络/)
    assert.equal(newPage.pending.value, true)
  })
}

for (const returnedEarly of [true, false]) {
  test(`离开上传页后${returnedEarly ? '在回包前重试' : '等回包后回到记录页'}，只转写与回填一次`, async (t) => {
    const bridge = recordingBridge(t)
    const uploads = []
    const oldText = []
    const newText = []
    let finishUpload
    const inFlight = new Promise((resolve) => {
      finishUpload = resolve
    })
    const upload = (path) => {
      uploads.push(path)
      return inFlight
    }
    const page = (text) =>
      useVoiceRecorder(
        {
          owner: () => bridge.account,
          onError: assert.fail,
          onTranscript: (value) => text.push(value),
        },
        upload,
      )
    const oldPage = page(oldText)
    oldPage.show()
    const capture = oldPage.start()
    await tick()
    oldPage.release()
    bridge.finish()
    await tick()
    assert.deepEqual(uploads, [bridge.saved])
    oldPage.hide(false)
    oldPage.cancel()
    const newPage = page(newText)
    if (!returnedEarly) {
      finishUpload('书店活动')
      await capture
    }
    newPage.show()
    await tick()
    const retry = newPage.pending.value ? newPage.retry() : Promise.resolve()
    if (returnedEarly) finishUpload('书店活动')
    await Promise.all([capture, retry])
    await tick()
    assert.deepEqual(oldText, [])
    assert.deepEqual(newText, ['书店活动'])
    assert.deepEqual(uploads, [bridge.saved])
    assert.equal(newPage.pending.value, false)
    assert.equal(existsSync(bridge.saved), false)
    newPage.hide(false)
    newPage.show()
    await tick()
    assert.deepEqual(newText, ['书店活动'])
  })
}

test('完全重启后重试同一文件，成功后再次重启不再上传', async (t) => {
  const bridge = recordingBridge(t)
  const errors = []
  const page = useVoiceRecorder(
    {
      owner: () => bridge.account,
      onError: (msg) => errors.push(msg),
      onTranscript: assert.fail,
    },
    async () => {
      throw new Error('已断网')
    },
  )
  page.show()
  const capture = page.start()
  await tick()
  page.release()
  bridge.finish()
  await capture
  assert.equal(page.pending.value, true)
  assert.match(errors[0], /断网/)
  const recovered = coldStart(bridge)
  assert.deepEqual(recovered.uploaded, [
    { path: bridge.saved, bytes: bridge.bytes.toString('hex') },
  ])
  assert.deepEqual(recovered.text, ['恢复后转写'])
  assert.equal(recovered.pending, false)
  assert.equal(existsSync(bridge.saved), false)
  assert.deepEqual(coldStart(bridge), {
    uploaded: [],
    text: [],
    pending: false,
  })
})

test('退页后收到转写，结束进程再回来仍能直接回填', async (t) => {
  const bridge = recordingBridge(t)
  const uploads = []
  let reply
  const page = useVoiceRecorder(
    {
      owner: () => bridge.account,
      onError: assert.fail,
      onTranscript: assert.fail,
    },
    (path) => {
      uploads.push(path)
      return new Promise((resolve) => {
        reply = resolve
      })
    },
  )
  page.show()
  const capture = page.start()
  await tick()
  page.release()
  bridge.finish()
  await tick()
  assert.deepEqual(uploads, [bridge.saved])
  page.hide(false)
  page.cancel()
  reply('离开后已转写')
  await capture
  assert.deepEqual(coldStart(bridge), {
    uploaded: [],
    text: ['离开后已转写'],
    pending: false,
  })
  assert.equal(existsSync(bridge.saved), false)
  assert.deepEqual(coldStart(bridge), {
    uploaded: [],
    text: [],
    pending: false,
  })
})
