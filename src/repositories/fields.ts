export type FieldValue = string | number | null | string[]
export type Field = (value: unknown) => FieldValue

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('需要文本')
  return value
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('需要整数')
  return value
}

export function positiveInteger(value: unknown): number {
  const number = integer(value)
  if (number <= 0) throw new Error('需要正整数')
  return number
}

export function nonnegativeInteger(value: unknown): number {
  const number = integer(value)
  if (number < 0) throw new Error('需要非负整数')
  return number
}

export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('需要有效的 UUID')
  }
  return value.toLowerCase()
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('需要文本数组')
  return Array.from(value, text)
}

export function nullable<T extends FieldValue>(field: (value: unknown) => T) {
  return (value: unknown) => (value === null ? null : field(value))
}

export function oneOf<const T extends string | number>(...choices: T[]) {
  return (value: unknown): T => {
    const choice = choices.find((candidate) => candidate === value)
    if (choice === undefined)
      throw new Error(`需填写 ${choices.join(' / ')} 中的一项`)
    return choice
  }
}

export const flag = oneOf(0, 1)

export function fromSql<T extends FieldValue>(
  field: (value: unknown) => T,
  raw: unknown,
): T {
  if (field === stringList && typeof raw === 'string')
    return field(JSON.parse(raw))
  // 兼容原生桥将 SQLite 整数序列化成十进制字符串、将空值字段省略的情况。
  if (
    typeof raw === 'string' &&
    /^-?\d+$/.test(raw) &&
    (field === integer ||
      field === positiveInteger ||
      field === nonnegativeInteger ||
      field === flag)
  ) {
    return field(Number(raw))
  }
  return field(raw ?? null)
}
