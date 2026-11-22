import { pullChanges, pushChanges } from '../api/sync'
import {
  applyPull,
  readExpansionSource,
  readPendingChanges,
  readSyncCursor,
} from '../repositories/sync'
import { useAuthStore } from '../store/auth'
import { firstPacket, syncedDataRevision } from './sync'

export async function prepareIdeaForAi(
  userId: string,
  ideaId: string,
  operation: 'expand' | 'breakdown' | 'research',
) {
  const auth = useAuthStore()
  const revision = auth.revision
  function checkSession() {
    if (!auth.token || auth.user?.id !== userId || auth.revision !== revision)
      throw new Error('登录状态已改变，请重新打开想法。')
  }
  checkSession()
  const source = await readExpansionSource(userId, ideaId)
  const tables =
    operation === 'breakdown'
      ? (['idea', 'expansion', 'step'] as const)
      : (['idea'] as const)
  if (source.pending || operation === 'breakdown') {
    // 先上传本想法的待传数据，让模型读取最新原文、思路及现有步骤顺序。
    const scope = { ideaId, tables }
    for (;;) {
      const sent = firstPacket(await readPendingChanges(userId, scope))
      const count = tables.reduce((sum, table) => sum + sent[table].length, 0)
      if (!count) break
      const cursor = await readSyncCursor(userId)
      checkSession()
      const { accepted } = await pushChanges(sent)
      checkSession()
      const remote = await pullChanges(accepted === count ? cursor : 0)
      checkSession()
      if (await applyPull(userId, remote, remote.server_time, sent))
        syncedDataRevision.value++
      const latest = await readExpansionSource(userId, ideaId)
      if (latest.idea.content !== source.idea.content)
        throw new Error('原文已更新，请确认后重新生成。')
    }
  }
  checkSession()
  return checkSession
}
