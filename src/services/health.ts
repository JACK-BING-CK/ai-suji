import { request } from '../api/http'

export async function checkService() {
  const result = await request<{ status: string }>('/health')
  if (result?.status !== 'ok') throw new Error('服务状态异常，请稍后重试。')
}
