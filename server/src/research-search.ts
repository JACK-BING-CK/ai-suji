import { load } from 'cheerio'
import { object } from './chat-model.js'
import { HttpError } from './errors.js'
import {
  domesticPublisherDomains,
  isDomesticMaterialUrl,
} from './research-link.js'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  source_name: string
  published_at: number
}

export type SearchProvider = (
  keyword: string,
  signal: AbortSignal,
) => Promise<SearchResult[]>

function cleanText(input: unknown, max: number) {
  if (typeof input !== 'string') return ''
  return input.replace(/\s+/g, ' ').trim().slice(0, max)
}

function cctvResults(html: string): SearchResult[] {
  const $ = load(html)
  const anchors = $('a[id^="web_content_"]').filter((_, el) =>
    /^web_content_\d+$/.test(el.attribs.id),
  )
  if (!anchors.length) {
    if (/没有找到[\s\S]*?相关网页结果/.test($('h3.tit').text())) return []
    throw new HttpError(503, '央视网搜索结果格式异常，请稍后重试。')
  }

  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    const link = $(anchor)
    // 标题链接经过点击统计，栏目属性保留了原文的真实链接。
    const raw = link.closest('span[lanmu1]').attr('lanmu1')
    if (!raw || seen.has(raw) || !isDomesticMaterialUrl(raw)) continue
    const url = new URL(raw)
    if (
      !(url.hostname === 'cctv.com' || url.hostname.endsWith('.cctv.com')) ||
      !/\/ARTI\w+\.shtml$/i.test(url.pathname)
    )
      continue
    const card = link.closest('li')
    const title = cleanText(link.text(), 300)
    const snippet = cleanText(card.find('p.bre').text(), 600)
    if (!title || !snippet) continue
    const time = card
      .find('span.tim')
      .text()
      .match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/)
    const published = time
      ? Date.parse(time[1] + 'T' + time[2] + '+08:00')
      : NaN
    results.push({
      title,
      url: raw,
      snippet,
      source_name: '央视网',
      published_at: Number.isFinite(published) ? published : 0,
    })
    seen.add(raw)
    if (results.length === 5) break
  }
  return results
}

function braveResults(data: unknown): SearchResult[] {
  if (!object(data) || data.error)
    throw new HttpError(503, '搜索服务返回的数据不可用。')
  if (data.web === undefined) return []
  if (!object(data.web) || !Array.isArray(data.web.results))
    throw new HttpError(503, '搜索结果格式异常，请稍后重试。')

  const results: SearchResult[] = []
  for (const row of data.web.results.slice(0, 5)) {
    if (
      !object(row) ||
      typeof row.url !== 'string' ||
      !isDomesticMaterialUrl(row.url)
    )
      continue
    const title = cleanText(row.title, 300)
    const snippet = cleanText(row.description, 600)
    if (!title || !snippet) continue
    const profile = object(row.profile) ? row.profile.name : ''
    // Brave 没有指明时区的页面时间使用 UTC，缺失时保留未知。
    let date = NaN
    if (
      typeof row.page_age === 'string' &&
      /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(row.page_age)
    ) {
      const raw = row.page_age
      date = Date.parse(
        raw.includes('T') && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
          ? raw + 'Z'
          : raw,
      )
    }
    results.push({
      title,
      url: row.url,
      snippet,
      source_name: cleanText(profile, 120) || new URL(row.url).hostname,
      published_at: Number.isFinite(date) ? date : 0,
    })
  }
  return results
}

export function createSearchProvider(env: NodeJS.ProcessEnv): SearchProvider {
  const key = env.SEARCH_API_KEY?.trim()
  return async (keyword, signal) => {
    const url = new URL(
      key
        ? 'https://api.search.brave.com/res/v1/web/search'
        : 'https://search.cctv.com/search.php',
    )
    const headers: Record<string, string> = {
      Accept: key ? 'application/json' : 'text/html',
      'User-Agent': 'AI-Suji/0.1 (user-initiated material search)',
    }
    if (key) {
      const sites = domesticPublisherDomains
        .map((domain) => 'site:' + domain)
        .join(' OR ')
      url.search = new URLSearchParams({
        q: keyword + ' (' + sites + ')',
        count: '5',
        text_decorations: 'false',
      }).toString()
      headers['X-Subscription-Token'] = key
    } else {
      url.search = new URLSearchParams({
        type: 'web',
        qtext: keyword,
        sort: 'relevance',
        page: '1',
      }).toString()
    }
    try {
      const response = await fetch(url, { signal, headers, redirect: 'error' })
      if (!response.ok) {
        if (response.status === 429)
          throw new HttpError(503, '搜索服务暂时限流，请稍后再找题材。')
        if ([401, 403].includes(response.status))
          throw new HttpError(503, '搜索服务拒绝请求，请检查后端搜索配置。')
        throw new HttpError(503, '搜索服务暂时无法访问，请稍后重试。')
      }
      return key
        ? braveResults(await response.json())
        : cctvResults(await response.text())
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(
        503,
        signal.aborted
          ? '素材搜索超时，请稍后重试。'
          : '无法连接搜索服务，请稍后重试。',
      )
    }
  }
}
