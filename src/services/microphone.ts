type Permission = 'granted' | 'newly-granted' | 'denied'

export async function requestMicrophone(): Promise<Permission> {
  // App-Plus 的 Vue 构建为两端共用，仅在原生包内按系统选择权限 API。
  // #ifdef APP-PLUS
  if (typeof plus !== 'undefined') {
    const status = uni.getAppAuthorizeSetting().microphoneAuthorized
    if (status === 'authorized') return 'granted'

    if (plus.os.name === 'Android') {
      // Android 未申请时也可能返回 denied，交由系统区分首次和永久拒绝。
      const permission = 'android.permission.RECORD_AUDIO'
      return new Promise((resolve, reject) => {
        plus.android.requestPermissions(
          [permission],
          (result: { granted: string[] }) =>
            resolve(
              result.granted.includes(permission) ? 'newly-granted' : 'denied',
            ),
          () => reject(new Error('无法申请麦克风权限，请到系统设置中检查。')),
        )
      })
    }
    if (plus.os.name === 'iOS') {
      if (status === 'denied') return 'denied'
      // iOS 首次由 AVAudioSession 请求授权，桥回调不传布尔值，需重新读取权限。
      const session = plus.ios
        .importClass('AVAudioSession')
        .sharedInstance() as {
        requestRecordPermission(callback: () => void): void
      }
      return new Promise((resolve, reject) => {
        session.requestRecordPermission(() => {
          try {
            resolve(
              uni.getAppAuthorizeSetting().microphoneAuthorized === 'authorized'
                ? 'newly-granted'
                : 'denied',
            )
          } catch {
            reject(new Error('无法读取麦克风权限，请到系统设置中检查。'))
          }
        })
      })
    }
  }
  // #endif
  throw new Error('请在手机 App 中使用语音速记。')
}

export async function showMicrophoneSettings() {
  const { confirm } = await uni.showModal({
    title: '需要麦克风权限',
    content: '请到系统设置中允许访问麦克风。你也可以继续打字记录。',
    confirmText: '去设置',
    cancelText: '继续打字',
  })
  if (confirm) {
    try {
      await uni.openAppAuthorizeSetting({})
    } catch {
      throw new Error('请打开系统设置，在本应用的权限中允许使用麦克风。')
    }
  }
}
