import {
  createChatModel,
  nonemptyText,
  object,
  type ModelReply,
} from './chat-model.js'
import { expansionPrompt, type ExpandTemplate } from './prompts/expand.js'

export { isExpandTemplate, type ExpandTemplate } from './prompts/expand.js'

export interface ExpandResult {
  background: string
  points: string[]
  risks: string
  next_steps: string
}

export type ExpandModel = (
  content: string,
  template: ExpandTemplate,
  retry: boolean,
  signal?: AbortSignal,
) => Promise<ModelReply>

export function parseExpansion(content: string): ExpandResult {
  let value: unknown
  try {
    value = JSON.parse(content.trim())
  } catch {
    throw new Error('模型输出不是有效 JSON。')
  }
  if (!object(value) || Object.keys(value).length !== 4)
    throw new Error('模型输出应包含背景、要点、风险和下一步四个字段。')
  const { background, points, risks, next_steps } = value
  if (
    !nonemptyText(background) ||
    !nonemptyText(risks) ||
    !nonemptyText(next_steps)
  )
    throw new Error('模型返回的背景、风险和下一步必须是非空字符串。')
  if (!Array.isArray(points) || !points.length || !points.every(nonemptyText))
    throw new Error('模型返回的要点必须是非空字符串数组。')
  return {
    background: background.trim(),
    points: points.map((point) => point.trim()),
    risks: risks.trim(),
    next_steps: next_steps.trim(),
  }
}

export function createExpandModel(
  env: NodeJS.ProcessEnv,
): ExpandModel | undefined {
  const chat = createChatModel(env)
  if (!chat) return undefined
  return (source, template, retry, signal) =>
    chat(expansionPrompt(template, retry), source, 'json_object', signal)
}
