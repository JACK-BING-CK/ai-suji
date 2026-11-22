# AI速记 规格说明（SPEC）

## 1. 数据模型（前端 SQLite 与后端 MySQL 字段保持一致）
通用字段：id（UUID 主键）、created_at、updated_at、deleted_at（软删除，可空）。时间均为 UTC 毫秒时间戳。

### user（用户，后端表）
- phone（手机号，唯一）、nickname、avatar_url、status（1正常/0已注销）

### idea（想法）
- user_id、content（原文，上限 2000 字）、source（text/voice/photo/share）
- tags（JSON 数组）、status（inbox/processed/archived）

### expansion（AI 思路，一条想法保留最新一份）
- idea_id、user_id、background（背景）、points（JSON 数组，要点）、risks（风险）、next_steps（下一步）、model（模型名）

### material（素材）
- idea_id、user_id、title、url、summary、source_name、published_at

### step（流程步骤）
- idea_id、user_id、title、detail、duration_min（预计分钟，正整数）、sort_order、depends_on（依赖的 step id，可空）、done（0/1）

### schedule（日程）
- user_id、idea_id（可空）、step_id（可空）、title、start_at、end_at、repeat_rule（RRULE 字符串，可空）、priority（0普通/1重要）、done（0/1）
- 单次日程和重复日程首个实例用 done 打卡，并与关联步骤联动。后续实例独立打卡，completed_slots（JSON 字符串数组，默认空）保存已完成的周期序号，从 1 开始，随日程同步。每月遇无对应日期时跳过该月，后续月份保持原序号。

### reminder（提醒）
- user_id、schedule_id、remind_at、level（0通知/1闹钟）、sound（铃声标识，可空）、snooze_min（默认 10）、enabled（0/1）、native_id（系统通知/闹钟标识，可空）

### usage_log（AI 用量）
- user_id、type（expand/breakdown/research/asr）、tokens、created_at

## 2. 接口清单（后端，统一前缀 /api，统一返回 {code, msg, data}，code=0 为成功）
- GET /health → {status:"ok"}（无需登录）
- POST /api/auth/login 入参 {phone, code} → {token, user}。验证码开发期用.env 的固定调试码，短信发送预留 provider 接口。
- GET /api/sync/pull?since={毫秒时间戳} → 六张业务表（idea/expansion/material/step/schedule/reminder）中 updated_at 大于 since 的记录（含软删除记录）。
- POST /api/sync/push 入参 {idea:[], expansion:[], material:[], step:[], schedule:[], reminder:[]} → {accepted, server_time}。冲突策略：同一 id 以 updated_at 较新者为准，软删除优先。
- POST /api/ai/expand 入参 {idea_id, template}，template 取值 article/video/product/study/general → 返回 expansion 对象。
- POST /api/ai/breakdown 入参 {idea_id} → 返回 step 数组。
- POST /api/ai/research 入参 {idea_id} → 返回 material 数组。
- POST /api/asr 入参 multipart 音频文件（≤60 秒）→ {text}。
- 通用错误码：401 未登录；403 无权访问；42901 今日 AI 额度已用完；500 服务端错误（msg 给可读说明）。
- 额度规则：每用户每天 expand + breakdown + research 合计 20 次（asr 不计），每次 AI 调用写一条 usage_log。
- 限流：同一 IP 每分钟最多 60 次请求。

## 3. AI 输出结构（后端校验，解析失败重试 1 次，仍失败返回 500 并写明原因）
- expand 输出 JSON：{"background":"字符串","points":["要点1","要点2"],"risks":"字符串","next_steps":"字符串"}
- breakdown 输出 JSON 数组：[{"title":"步骤名","detail":"说明","duration_min":30,"depends_on_index":null}]；depends_on_index 为数组下标或 null；步骤数 3–12；服务端必须做依赖环检测，成环时丢弃依赖关系按顺序重排。
- research 流程：先提取 3–5 个搜索关键词，每词取 ≤5 条搜索结果，再摘要为 {"title","url","summary","source_name","published_at"} 数组；摘要只能基于搜索返回内容，url 必须原样保留，禁止编造链接。
