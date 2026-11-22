import process from 'node:process'
import { ideaRepository } from '../../src/repositories/idea.ts'
import { saveIdeaEdits } from '../../src/services/ideas.ts'
import { installBridge } from './sqlite-bridge.mjs'

const [file, owner] = process.argv.slice(2)
installBridge(file)
const idea = await ideaRepository.create(owner, {
  content: '初稿',
  tags: ['旧标签'],
})
await saveIdeaEdits(owner, idea.id, '杀进程前已提交', ['修改后的标签', '备忘'])
process.on('message', () => {}) // 等待父进程强制结束，刻意不关闭数据库。
process.send(idea.id)
