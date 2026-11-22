import type { GenerateModel } from './ai-generation.js'
import { createChatModel, object, nonemptyText } from './chat-model.js'
import { materialPrompt, formatRetry } from './prompts/research.js'
import { canOpenMaterial } from './research-link.js'
import {
  createSearchProvider,
  type SearchProvider,
  type SearchResult,
} from './research-search.js'

export interface ResearchProviders {
  search: SearchProvider
  summarize: GenerateModel
  verifyLink?: typeof canOpenMaterial
}

export function createResearchProviders(
  env: NodeJS.ProcessEnv,
): ResearchProviders | undefined {
  const chat = createChatModel(env)
  if (!chat) return undefined
  return {
    search: createSearchProvider(env),
    verifyLink: canOpenMaterial,
    summarize: (source, retry, signal) =>
      chat(materialPrompt + (retry ? formatRetry : ''), source, 'text', signal),
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('输出不是有效 JSON。')
  }
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set(
  '一个 一篇 一下 如何 关于 介绍 想要 可以 什么 这个 以及 我们 我想 帮我 做个 文章 想法 什么样 怎么 研究 the an and or for of with to how about is are in on'.split(
    ' ',
  ),
)

export function extractKeywords(source: string): string[] {
  const terms = new Map<string, number>()
  for (const { segment, isWordLike } of segmenter.segment(
    source.toLowerCase(),
  )) {
    if (!isWordLike || stopWords.has(segment) || segment.length < 2) continue
    const term = Array.from(segment).slice(0, 48).join('')
    terms.set(term, (terms.get(term) ?? 0) + 1)
  }
  const ranked = [...terms]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
  const topic = ranked[0] ?? Array.from(source.trim()).slice(0, 48).join('')
  if (!topic) return []
  // 极短想法仍用其原文作为检索主题，并从背景、实例两个角度检索。
  const candidates = new Set([
    ranked.slice(0, 2).join(' ') || topic,
    ...ranked,
    topic + ' 背景',
    topic + ' 案例',
  ])
  return [...candidates].slice(0, 3)
}

export function parseMaterials(
  content: string,
  sources: Map<string, SearchResult>,
) {
  const data = parseJson(content)
  if (!Array.isArray(data) || data.length > 5 || data.length > sources.size)
    throw new Error('素材必须是已检索来源的数组。')
  const seen = new Set<string>()
  return data.map((value: unknown) => {
    if (
      !object(value) ||
      Object.keys(value).length !== 5 ||
      typeof value.url !== 'string' ||
      !nonemptyText(value.summary) ||
      value.summary.length > 2000
    )
      throw new Error('素材缺少有效链接或摘要。')
    const hit = sources.get(value.url)
    if (!hit || seen.has(hit.url))
      throw new Error('素材链接必须逐字来自本次搜索结果且不得重复。')
    if (
      value.title !== hit.title ||
      value.source_name !== hit.source_name ||
      value.published_at !== hit.published_at
    )
      throw new Error('标题、来源和日期必须与对应搜索结果相同。')
    seen.add(hit.url)
    return {
      title: hit.title,
      url: hit.url,
      source_name: hit.source_name,
      published_at: hit.published_at,
      summary: value.summary.trim(),
    }
  })
}

export async function searchSources(
  source: string,
  search: SearchProvider,
  signal: AbortSignal,
) {
  const sources = new Map<string, SearchResult>()
  for (const keyword of extractKeywords(source)) {
    const hits = await search(keyword, signal)
    for (const hit of hits.slice(0, 5)) {
      if (!sources.has(hit.url)) sources.set(hit.url, hit)
    }
  }
  return sources
}
