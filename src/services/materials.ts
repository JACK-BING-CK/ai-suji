import { requestMaterials } from '../api/research'
import { materialRepository } from '../repositories/material'
import { storeResearchedMaterials } from '../repositories/sync'
import { prepareIdeaForAi } from './ai-source'
import { syncedDataRevision } from './sync'

export type { Material } from '../api/research'

export function loadMaterials(owner: string, ideaId: string) {
  return materialRepository.list(owner, {
    where: { idea_id: ideaId },
    orderBy: 'created_at',
  })
}

export async function findMaterials(
  owner: string,
  ideaId: string,
  search = requestMaterials,
) {
  const checkSession = await prepareIdeaForAi(owner, ideaId, 'research')
  checkSession()
  const rows = await search(ideaId)
  checkSession()
  try {
    if (await storeResearchedMaterials(owner, ideaId, rows))
      syncedDataRevision.value++
  } catch (cause) {
    throw new Error('素材暂未保存到本机，请联网同步后重新读取。', { cause })
  }
  checkSession()
  return rows.length
}

export function deleteMaterial(owner: string, id: string) {
  return materialRepository.remove(owner, id)
}

export function openMaterialUrl(
  url: string,
  onError: (message: string) => void,
) {
  // 素材也可能来自较早版本的同步记录。只允许网页地址，完整保留来源的路径、参数与片段。
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]
  if (
    !authority ||
    /[\s\\]/.test(url) ||
    !/^(?:\[[0-9a-f:.]+\]|[a-z0-9.\-\u0080-\uFFFF]+)(?::\d{1,5})?$/i.test(
      authority,
    ) ||
    Array.from(url).some(
      (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
    )
  ) {
    onError('这条素材的原文链接无效。')
    return
  }
  try {
    // #ifdef APP-PLUS
    // Android 和 iOS 均交给系统浏览器打开网页。
    if (typeof plus !== 'undefined' && plus.runtime) {
      plus.runtime.openURL(url, () => onError('浏览器无法打开原文链接。'))
      return
    }
    // #endif
    // #ifdef H5
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    // #endif
    onError('当前设备无法打开浏览器。')
  } catch {
    onError('浏览器无法打开原文链接。')
  }
}
