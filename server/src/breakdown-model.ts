import type { GenerateModel } from './ai-generation.js'
import { createChatModel, nonemptyText, object } from './chat-model.js'
import { breakdownPrompt } from './prompts/breakdown.js'

export function createBreakdownModel(
  env: NodeJS.ProcessEnv,
): GenerateModel | undefined {
  const chat = createChatModel(env)
  if (!chat) return undefined
  // json_object 模式只允许顶层对象；这里直接请求数组，再逐项做结构校验。
  return (source, retry, signal) =>
    chat(breakdownPrompt(retry), source, 'text', signal)
}

export function parseBreakdown(content: string) {
  let input: unknown
  try {
    input = JSON.parse(content)
  } catch {
    throw new Error('模型输出不是有效 JSON。')
  }
  if (!Array.isArray(input) || input.length < 3 || input.length > 12)
    throw new Error('模型必须返回包含 3 至 12 个步骤的数组。')

  const steps = input.map((entry: unknown, index) => {
    if (!object(entry) || Object.keys(entry).length !== 4)
      throw new Error('步骤必须包含标题、说明、时长和依赖下标。')
    const { title, detail, duration_min, depends_on_index } = entry
    if (!nonemptyText(title) || !nonemptyText(detail))
      throw new Error('每一步的标题和说明必须是非空字符串。')
    if (Buffer.byteLength(title.trim(), 'utf8') > 65535)
      throw new Error('步骤标题超出可存储长度。')
    if (
      typeof duration_min !== 'number' ||
      !Number.isInteger(duration_min) ||
      duration_min < 1 ||
      duration_min > 2147483647
    )
      throw new Error('每一步的时长必须是有效的正整数分钟数。')
    if (
      depends_on_index !== null &&
      (typeof depends_on_index !== 'number' ||
        !Number.isInteger(depends_on_index) ||
        depends_on_index < 0 ||
        depends_on_index >= input.length)
    )
      throw new Error('步骤依赖下标必须指向数组中的步骤，或为 null。')
    return {
      index,
      title: title.trim(),
      detail: detail.trim(),
      duration_min,
      depends_on_index,
    }
  })

  // 每次选原始顺序中最早的可执行步骤。若剩余步骤互相等待，整批按原序解除依赖。
  const emitted = new Set<number>()
  const sorted: typeof steps = []
  while (sorted.length < steps.length) {
    const next = steps.find(
      (step) =>
        !emitted.has(step.index) &&
        (step.depends_on_index === null || emitted.has(step.depends_on_index)),
    )
    if (!next) return steps.map((step) => ({ ...step, depends_on_index: null }))
    emitted.add(next.index)
    sorted.push(next)
  }
  return sorted
}
