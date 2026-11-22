import type { Expansion } from './expansion'

type Branches = Pick<
  Expansion,
  'background' | 'points' | 'risks' | 'next_steps'
>
type Box = { x: number; y: number; width: number; height: number }
interface Branch extends Box {
  label: string
  color: string
  paragraphs: string[][]
}
export interface MindMap {
  width: number
  height: number
  title: string[]
  center: Box
  branches: Branch[]
}

const bodySize = 26
const leading = 40
const padding = 26
const branchGap = 64
const margin = 40

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null

// 旧版 WebView 回退到按码点换行；绘制时再按可用行宽微调。
function wrap(text: string, width: number, size: number): string[] {
  const rows: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let row = ''
    let used = 0
    const chars = segmenter
      ? Array.from(segmenter.segment(paragraph), (item) => item.segment)
      : paragraph
    for (const ch of chars) {
      const w =
        size *
        (/[\t]/.test(ch)
          ? 2
          : /[ilI1.,'’ !:;|]/.test(ch)
            ? 0.39
            : /[MW@%]/.test(ch)
              ? 0.95
              : ch.length === 1 && ch.charCodeAt(0) < 128
                ? 0.69
                : 1)
      if (row && used + w > width) {
        rows.push(row)
        row = ''
        used = 0
      }
      row += ch
      used += w
    }
    rows.push(row)
  }
  return rows
}

export function ideaMapTitle(content: string) {
  const first =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  return first.match(/^.*?[。！？!?](?=\s*\S)/u)?.[0] || first || '想法'
}

function layout(title: string, data: Branches, width: number): MindMap {
  const cardWidth = (width - margin * 2 - branchGap) / 2
  const branches = [
    { label: '背景', color: '#246b69', texts: [data.background] },
    { label: '要点', color: '#325f85', texts: data.points },
    { label: '风险', color: '#92552b', texts: [data.risks] },
    { label: '下一步', color: '#476c40', texts: [data.next_steps] },
  ].map(({ label, color, texts }, i) => {
    const paragraphs = texts.map((value) =>
      wrap(value, cardWidth - padding * 2 - (i === 1 ? 23 : 0), bodySize),
    )
    const h =
      80 +
      paragraphs.reduce((sum, lines) => sum + lines.length * leading, 0) +
      Math.max(paragraphs.length - 1, 0) * 14 +
      padding
    return {
      label,
      color,
      paragraphs,
      width: cardWidth,
      height: h,
      x: margin + (i % 2) * (cardWidth + branchGap),
      y: 0,
    }
  })
  const upperEnd = 112 + Math.max(branches[0].height, branches[1].height)
  branches[0].y = upperEnd - branches[0].height
  branches[1].y = upperEnd - branches[1].height
  const centerWidth = Math.round((width - 2 * margin) * 0.7)
  const titleLines = wrap(title, centerWidth - padding * 2, 34)
  const center = {
    width: centerWidth,
    height: 36 + titleLines.length * 48,
    x: (width - centerWidth) / 2,
    y: upperEnd + 48,
  }
  const lowerStart = center.y + center.height + 48
  branches[2].y = lowerStart
  branches[3].y = lowerStart
  return {
    width,
    height:
      lowerStart + Math.max(branches[2].height, branches[3].height) + margin,
    title: titleLines,
    center,
    branches,
  }
}

export function layoutMindMap(idea: string, data: Branches): MindMap {
  const title = ideaMapTitle(idea)
  let map = layout(title, data, 1200)
  // 长文增加横向排版空间，避免按手机屏幕比例导出又窄又长的截图。
  for (const width of [1600, 2200, 3000]) {
    if (map.height <= 3400) break
    map = layout(title, data, width)
  }
  return map
}

type Canvas = UniNamespace.CanvasContext

function rounded(ctx: Canvas, box: Box, color: string, radius: number) {
  const { x, y, width, height } = box
  const right = x + width,
    bottom = y + height
  ctx.setFillStyle(color)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(right - radius, y)
  ctx.quadraticCurveTo(right, y, right, y + radius)
  ctx.lineTo(right, bottom - radius)
  ctx.quadraticCurveTo(right, bottom, right - radius, bottom)
  ctx.lineTo(x + radius, bottom)
  ctx.quadraticCurveTo(x, bottom, x, bottom - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
  ctx.fill()
}

function text(
  ctx: Canvas,
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  width: number,
) {
  ctx.setFontSize(size)
  ctx.setFillStyle(color)
  ctx.fillText(value, x, y, width)
}

export function drawMindMap(ctx: Canvas, map: MindMap) {
  const { width, height, center, branches } = map
  ctx.setFillStyle('#f6f4ed')
  ctx.fillRect(0, 0, width, height)
  ctx.setTextBaseline('middle')
  text(ctx, '思维导图', margin, 57, 38, '#233d3c', 240)
  rounded(
    ctx,
    { x: width - margin - 138, y: 34, width: 138, height: 44 },
    '#dcebe5',
    22,
  )
  text(ctx, 'AI 生成', width - margin - 111, 56, 26, '#205850', 100)
  for (const [index, card] of branches.entries()) {
    const upper = index < 2
    const fromY = upper ? center.y : center.y + center.height
    const toY = upper ? card.y + card.height : card.y
    const rootX = width / 2
    const endX = card.x + card.width / 2
    const midY = (fromY + toY) / 2
    ctx.setStrokeStyle(card.color)
    ctx.setLineWidth(3)
    ctx.beginPath()
    ctx.moveTo(rootX, fromY)
    ctx.lineTo(rootX, midY)
    ctx.lineTo(endX, midY)
    ctx.lineTo(endX, toY)
    ctx.stroke()
    rounded(ctx, card, '#d9dfd7', 20)
    rounded(
      ctx,
      {
        x: card.x + 2,
        y: card.y + 2,
        width: card.width - 4,
        height: card.height - 4,
      },
      '#fffef9',
      18,
    )
    rounded(
      ctx,
      { x: card.x + padding, y: card.y + 26, width: 7, height: 33 },
      card.color,
      3,
    )
    text(
      ctx,
      card.label,
      card.x + padding + 19,
      card.y + 42,
      31,
      card.color,
      card.width - padding * 2 - 19,
    )
    let y = card.y + 90
    const points = index === 1
    for (const paragraph of card.paragraphs) {
      if (points) {
        ctx.setFillStyle(card.color)
        ctx.beginPath()
        ctx.arc(card.x + padding + 4, y, 4, 0, 2 * Math.PI)
        ctx.fill()
      }
      for (const line of paragraph) {
        text(
          ctx,
          line,
          card.x + padding + (points ? 23 : 0),
          y,
          bodySize,
          '#243536',
          card.width - padding * 2 - (points ? 23 : 0),
        )
        y += leading
      }
      y += 14
    }
  }
  rounded(ctx, center, '#195c56', 22)
  ctx.setTextAlign('center')
  map.title.forEach((line, i) =>
    text(
      ctx,
      line,
      width / 2,
      center.y + 42 + i * 48,
      34,
      '#ffffff',
      center.width - padding * 2,
    ),
  )
  ctx.setTextAlign('left')
}
