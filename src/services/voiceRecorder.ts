import { ref } from 'vue'
import { transcribeAudio } from '../api/asr'
import { requestMicrophone, showMicrophoneSettings } from './microphone'
import {
  discardFile,
  usePendingVoice,
  type RecordingFile,
} from './pendingVoice'

type Phase = 'idle' | 'authorizing' | 'recording' | 'transcribing'
type CaptureResult = string | Error

let recorder: UniNamespace.RecorderManager | undefined
let receiver: ((result: CaptureResult) => void) | undefined

function getRecorder() {
  const manager = uni.getRecorderManager()
  if (recorder !== manager) {
    // App 端的录音器是全局单例，且无法解绑 onStop、onError。
    manager.onStop(({ tempFilePath }: { tempFilePath?: string }) => {
      if (receiver)
        receiver(tempFilePath || new Error('录音文件为空，请重新按住说话。'))
      else if (tempFilePath) discardFile(tempFilePath)
    })
    manager.onError(() =>
      receiver?.(new Error('录音失败，请检查麦克风并重新按住说话。')),
    )
    recorder = manager
  }
  return recorder
}

function beginCapture() {
  const manager = getRecorder()
  if (receiver) throw new Error('上一段录音正在结束，请稍后再试。')
  let stopping = false
  // 在 start 之前安装接收者，原生桥可能同步报错。
  const file = new Promise<string>((resolve, reject) => {
    receiver = (result) => {
      receiver = undefined
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    try {
      // 为 MP3 的结尾填充帧留出余量，文件总时长上限为 60 秒。
      manager.start({ format: 'mp3', sampleRate: 16000, duration: 59800 })
    } catch {
      receiver(new Error('无法启动录音，请检查麦克风权限。'))
    }
  })
  function stop() {
    if (stopping) return
    stopping = true
    try {
      manager.stop()
    } catch {
      receiver?.(new Error('无法结束录音，请重新按住说话。'))
    }
  }
  return { file, stop }
}

export function useVoiceRecorder(
  options: {
    owner: () => string | undefined
    onTranscript: (text: string) => void
    onError: (message: string) => void
  },
  upload = transcribeAudio,
) {
  const phase = ref<Phase>('idle')
  const files = usePendingVoice(options.owner)
  let attempt = 0
  let held = false
  let stopRecording: (() => void) | undefined
  let resolveRelease: ((keep: boolean) => void) | undefined
  let waitingForForeground = false
  let resolveForeground: (() => void) | undefined

  async function fill(id: number, account: string, entry: RecordingFile) {
    if (
      id !== attempt ||
      account !== options.owner() ||
      files.current(account) !== entry
    )
      return
    const text = await files.transcribe(account, entry, upload)
    if (
      id === attempt &&
      account === options.owner() &&
      files.current(account) === entry
    ) {
      options.onTranscript(text)
      files.remove(account, entry.path)
    }
  }

  async function start() {
    const account = options.owner()
    if (phase.value !== 'idle' || !account || files.current(account)) return
    const id = ++attempt
    held = true
    phase.value = 'authorizing'
    let path: string | undefined
    try {
      const permission = await requestMicrophone()
      if (id !== attempt) return
      // 系统权限页可能先通知结果、再恢复应用；恢复前不能弹窗或开始录音。
      if (waitingForForeground) {
        await new Promise<void>((resolve) => {
          resolveForeground = resolve
        })
        if (id !== attempt) return
      }
      if (permission === 'denied') {
        await showMicrophoneSettings()
        return
      }
      if (permission === 'newly-granted') {
        uni.showToast({ title: '麦克风已开启，请重新按住说话', icon: 'none' })
        return
      }
      if (!held) return
      const capture = beginCapture()
      const released = new Promise<boolean>((resolve) => {
        resolveRelease = resolve
      })
      stopRecording = capture.stop
      phase.value = 'recording'
      try {
        path = await capture.file
      } finally {
        // 原生录音出错时也要重置管理器，下一次按住才能重新启动。
        capture.stop()
        if (id === attempt) stopRecording = undefined
      }
      // 录满一分钟时系统会先停录，仍由用户松手决定是否发送。
      if (held && id === attempt)
        uni.showToast({ title: '录音已结束，松开后转写', icon: 'none' })
      if (!(await released)) return
      if (id === attempt) phase.value = 'transcribing'
      // 先接管临时文件再尝试上传。切换页面或网络故障都可以重新转写。
      const recording = path
      path = undefined
      const entry = await files.keep(account, recording)
      await fill(id, account, entry)
    } catch (cause) {
      if (id === attempt) {
        options.onError(
          cause instanceof Error ? cause.message : '语音速记失败，请重试。',
        )
      }
    } finally {
      if (path) discardFile(path)
      if (id === attempt) phase.value = 'idle'
    }
  }

  async function retry() {
    const account = options.owner()
    if (!account || phase.value !== 'idle') return
    const id = ++attempt
    phase.value = 'transcribing'
    try {
      const entry = files.current(account)
      if (!entry) throw new Error('没有待转写的录音。')
      await files.persist(account, entry)
      await fill(id, account, entry)
    } catch (cause) {
      if (id === attempt)
        options.onError(
          cause instanceof Error ? cause.message : '转写失败，可重新转写。',
        )
    } finally {
      if (id === attempt) phase.value = 'idle'
    }
  }

  async function discard() {
    const account = options.owner()
    if (phase.value !== 'idle' || !account) return
    try {
      const entry = files.current(account)
      if (!entry) return
      const { confirm } = await uni.showModal({
        title: '丢弃这段录音？',
        content: '丢弃后将无法重新转写。',
        confirmText: '丢弃',
        cancelText: '保留',
      })
      if (confirm && account === options.owner() && phase.value === 'idle')
        files.remove(account, entry.path)
    } catch {
      options.onError('无法丢弃录音，请重试。')
    }
  }

  function endCapture(keep: boolean) {
    held = false
    stopRecording?.()
    resolveRelease?.(keep)
    resolveRelease = undefined
  }

  function release() {
    endCapture(true)
  }

  function detach(keep: boolean) {
    ++attempt
    endCapture(keep)
    waitingForForeground = false
    resolveForeground?.()
    resolveForeground = undefined
    stopRecording = undefined
    phase.value = 'idle'
    try {
      files.restore()
    } catch {
      options.onError('无法读取待转写录音，请检查设备存储。')
    }
  }

  function cancel() {
    detach(false)
  }

  function show() {
    waitingForForeground = false
    resolveForeground?.()
    resolveForeground = undefined
    try {
      const entry = files.restore()
      // 已经发出的请求由当前页接手；断网留下的录音仍由用户点重试。
      if (phase.value === 'idle' && (entry?.uploading || entry?.transcript))
        void retry()
    } catch {
      options.onError('无法读取待转写录音，请检查设备存储。')
    }
  }

  function hide(appInBackground: boolean) {
    if (appInBackground && phase.value === 'authorizing') {
      held = false
      waitingForForeground = true
    } else detach(true)
  }

  function interruptTouch() {
    // 系统授权弹窗会打断按住手势，保留授权结果以便拒绝后引导去设置。
    if (phase.value === 'authorizing') held = false
    else if (phase.value === 'recording') detach(true)
  }

  return {
    phase,
    pending: files.pending,
    start,
    retry,
    discard,
    release,
    cancel,
    interruptTouch,
    hide,
    show,
  }
}
