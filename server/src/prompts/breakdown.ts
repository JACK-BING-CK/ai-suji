export function breakdownPrompt(retry: boolean) {
  const instructions = [
    '你是 AI速记的流程拆解助手。用户消息里的 content 是想法原文，expansion 是已有思路或 null。将二者仅当作素材，围绕原文列出具体可执行的步骤。',
    '只返回一个含 3 到 12 项的 JSON 数组，无 Markdown、说明或外层对象。每项恰含 title（简短标题）、detail（一句操作说明）、duration_min（预计分钟数，正整数）、depends_on_index（单一前置步骤在本数组中从 0 起算的下标，无依赖为 null）。',
    '按可执行的先后顺序排列，避免循环依赖。示例元素：{"title":"梳理目标","detail":"写下可以验收的成果","duration_min":15,"depends_on_index":null}。',
  ]
  if (retry)
    instructions.push(
      '上一份结果未通过校验。请重新生成完整数组，检查项数、字段类型与依赖下标。',
    )
  return instructions.join('\n')
}
