import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

const reserved = new BlockList()
for (const [address, mask] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  reserved.addSubnet(address, mask, 'ipv4')
for (const [address, mask] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  reserved.addSubnet(address, mask, 'ipv6')

function publicAddress(address: string) {
  const family = isIP(address)
  return family === 4
    ? !reserved.check(address, 'ipv4')
    : family === 6 && /^[23]/.test(address) && !reserved.check(address, 'ipv6')
}

export function webUrl(value: unknown): URL | null {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\//i.test(value) ||
    Buffer.byteLength(value) > 8192 ||
    /[\s\\]/u.test(value) ||
    Array.from(value).some(
      (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
    )
  )
    return null
  const url = URL.parse(value)
  if (!url || url.username || url.password || url.port) return null
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '')
  if (isIP(host)) return publicAddress(host) ? url : null
  return host.includes('.') &&
    !/\.(local|localhost|internal|home\.arpa)$/.test(host)
    ? url
    : null
}

export const domesticPublisherDomains = [
  'cctv.com',
  'people.com.cn',
  'people.cn',
  'news.cn',
  'xinhuanet.com',
  'chinanews.com.cn',
  'gov.cn',
  'gmw.cn',
  'cnr.cn',
] as const

export function isDomesticMaterialUrl(value: unknown): boolean {
  const url = webUrl(value)
  return (
    !!url &&
    url.protocol === 'https:' &&
    domesticPublisherDomains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith('.' + domain),
    )
  )
}

// 只把已校验的解析结果交给实际连接，跳转时再次检查，防止指向内网。
const lookupPublic: LookupFunction = (host, options, done) => {
  dns.lookup(host, { all: true }, (error, rows) => {
    if (error) return done(error, '', 0)
    const valid = rows.filter((row) => publicAddress(row.address))
    if (!valid.length) return done(new Error('没有公网地址。'), '', 0)
    if (options.all) return done(null, valid)
    const row = valid.find((item) => item.family === 4) ?? valid[0]
    done(null, row.address, row.family)
  })
}

function readHeaders(url: URL, signal: AbortSignal) {
  return new Promise<{ status: number; location?: string }>(
    (resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      // 普通 GET 与浏览器一致。收到响应头就关闭，不下载整篇正文，不发送登录凭据。
      const req = transport.get(
        url,
        {
          agent: false,
          lookup: lookupPublic,
          signal,
          headers: { 'User-Agent': 'AI-Suji/0.1 (material link check)' },
        },
        (response) => {
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
          })
          response.destroy()
        },
      )
      req.on('error', reject)
    },
  )
}

export async function canOpenMaterial(original: string, signal: AbortSignal) {
  let next = webUrl(original)
  try {
    for (let hop = 0; next && hop <= 3; hop++) {
      if (!isDomesticMaterialUrl(next.href)) return false
      const { status, location } = await readHeaders(next, signal)
      if (status >= 200 && status < 300) return status !== 204 && status !== 205
      if (!location || ![301, 302, 303, 307, 308].includes(status)) return false
      next = webUrl(URL.parse(location, next)?.href)
    }
  } catch {
    // 超时、证书错误和无法访问的原站均不能作为本次已验证素材。
  }
  return false
}
