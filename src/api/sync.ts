import type { SyncBatch } from '../repositories/sync'
import { request } from './http'

export function pullChanges(since: number) {
  return request<SyncBatch & { server_time: number }>(
    '/api/sync/pull?since=' + since,
  )
}

export function pushChanges(batch: SyncBatch) {
  return request<{ accepted: number; server_time: number }>('/api/sync/push', {
    method: 'POST',
    data: batch,
  })
}
