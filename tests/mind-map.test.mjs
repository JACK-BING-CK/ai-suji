import assert from 'node:assert/strict'
import test from 'node:test'
import {
  drawMindMap,
  ideaMapTitle,
  layoutMindMap,
} from '../src/services/mindMap.ts'

test('中心标题取原文首句，四个分支都保留完整文字且互不重叠', () => {
  const title = '怎样记录社区里的故事？'
  const input = {
    background: '采访之前先说明用途。'.repeat(95),
    points: ['第一点\n第二段', '中文、English、数字 123 和 👩‍🎨。'.repeat(47)],
    risks: '没有得到受访者同意时暂缓发表。',
    next_steps: '逐条核对记录。'.repeat(63) + '【末尾】',
  }
  const layout = layoutMindMap('\n' + title + '这是第二句。\n原文正文。', input)
  assert.equal(ideaMapTitle('一个标题\n正文'), '一个标题')
  assert.equal(layout.title.join(''), title)
  assert.deepEqual(
    layout.branches.map((b) => b.label),
    ['背景', '要点', '风险', '下一步'],
  )
  const expected = [
    [input.background],
    input.points,
    [input.risks],
    [input.next_steps],
  ]
  const boxes = [layout.center, ...layout.branches]
  for (const [i, b] of boxes.entries()) {
    assert.ok(
      b.x >= 0 &&
        b.y >= 0 &&
        b.x + b.width <= layout.width &&
        b.y + b.height <= layout.height,
    )
    for (const other of boxes.slice(i + 1))
      assert.ok(
        b.x + b.width <= other.x ||
          other.x + other.width <= b.x ||
          b.y + b.height <= other.y ||
          other.y + other.height <= b.y,
      )
  }
  for (const [i, b] of layout.branches.entries()) {
    assert.deepEqual(
      b.paragraphs.map((p) => p.join('')),
      expected[i].map((s) => s.replaceAll('\n', '')),
    )
  }
  const text = []
  const ctx = new Proxy(
    {
      fillText: (value, x, y, width) => {
        assert.ok(x > 0 && y > 0 && y < layout.height && width > 0)
        text.push(value)
      },
    },
    { get: (obj, key) => obj[key] ?? (() => {}) },
  )
  drawMindMap(ctx, layout)
  assert.ok(text.includes('AI 生成'))
  assert.ok(text.includes(title))
  assert.ok(text.join('').includes('【末尾】'))
})
