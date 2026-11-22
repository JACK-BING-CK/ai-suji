interface Plus {
  readonly globalEvent?: {
    addEventListener(name: 'newintent', handler: () => void): void
  }
}

declare module '@/uni_modules/suji-system' {
  export function invokeSystem(
    operation: string,
    payload: string,
    callback: (result: string) => void,
  ): void
}
