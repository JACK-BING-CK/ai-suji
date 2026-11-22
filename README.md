# AI速记（ai-suji）

AI速记是一款面向 Android 和 iOS 的想法记录应用。先记下想法，用 AI 扩写思路、联网找素材，再把想法拆成步骤、排入日程并设置提醒。「记录」支持离线保存文字，也可以按住说话、松开转写，编辑后保存。上传失败时，录音保存在当前账号的本机存储，可在网络恢复后重新转写。收集箱按创建时间倒序排列，点开可看详情，左滑可删除。「日程」支持月历、周历和今日待办，可离线新建、编辑和打卡。数据模型、接口及 AI 输出约定见 [SPEC.md](./SPEC.md)。

## 技术栈

- 客户端使用 uni-app、Vue 3、TypeScript 和 Pinia，移动端编译目标为 App-Plus。工程基于 [DCloud 官方 Vue 3 + TypeScript 模板](https://github.com/dcloudio/uni-preset-vue/tree/vite-ts)。
- 后端使用 Node.js、Express 和 TypeScript。移动端以 SQLite 离线读写，服务端使用 MySQL。健康检查可独立运行。
- 前后端启用 TypeScript 严格模式，使用 ESLint 检查代码、Prettier 统一格式。Husky 在提交前调用 lint-staged 检查暂存文件。

## 启动命令

开发环境使用 Node.js 24 和 npm。在项目根目录执行 `npm ci`，一次安装前端和 `server` 工作区的依赖。随后按需在独立终端运行以下命令。

| 命令 | 用途 |
| --- | --- |
| `npm run dev:server` | 启动后端开发服务，监听文件变更 |
| `npm run dev:app` | 启动 App-Plus 开发编译并持续监听源码变更 |
| `npm run dev:h5` | 启动 H5 预览，打开终端打印的本地地址查看页面 |
| `npm run build:app` | 生成 App-Plus 发布资源，供原生打包使用 |
| `npm run build:server` | 编译后端，随后可用 `npm run start -w @ai-suji/server` 启动编译产物 |

后端启动后，访问 `http://localhost:3000/health` 即可检查服务。该接口无需登录，正常时返回 `{"status":"ok"}`。

创建一个 MySQL 数据库，在本机 `server/.env` 填写连接信息。运行 `npm run db:migrate -w @ai-suji/server` 校验和应用迁移。正式模式下的后端使用 `npm run start -w @ai-suji/server` 启动。

首次联调时配置设备可达的 `VITE_API_BASE_URL`，在 `server/.env` 填写数据库连接、`JWT_SECRET` 和 `SMS_DEBUG_CODE`，执行下文的数据库迁移并启动开发服务。「我的 → 登录」使用手机号和开发验证码。已登录设备会保存 JWT，可断网读写。已有旧版体验记录时，登录页可选择将它们导入当前手机号。短信发送与验证的接入点为 `SmsProvider`，固定验证码只在开发或测试模式启用。

登录后客户端先发送本机待同步数据，再全量拉取。写入与软删除会在同一个 SQLite 事务内登记待推送版本。恢复联网时自动补传，进入前台时增量拉取。同步失败保留本机数据和队列，「我的」可查看失败原因。业务请求共用 15 秒超时，登录令牌失效时清理当前会话并跳转登录页。

## 当前接口

| 方法与路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /health` | 公开 | 返回 `{"status":"ok"}` |
| `POST /api/auth/login` | 手机号、验证码 | 提交 `{phone,code}`，返回 `{token,user}` |
| `GET /api/sync/pull?since=0` | Bearer JWT | 返回六张表的记录（含软删除）和本次快照的 `server_time` |
| `POST /api/sync/push` | Bearer JWT | 提交六表变更数组，返回实际采纳数 `accepted` 和 `server_time` |
| `POST /api/ai/expand` | Bearer JWT | 提交 `{idea_id,template}`，按已保存原文生成并返回最新一份 expansion |
| `POST /api/ai/breakdown` | Bearer JWT | 提交 `{idea_id}`，根据原文及已有思路追加 3–12 个步骤，返回本次新增的 step 数组 |
| `POST /api/asr` | Bearer JWT | 用 multipart 的 `audio` 字段上传不超过 60 秒的 MP3 或 PCM WAV，返回可编辑的转写 `{text}` |
| `POST /api/ai/research` | Bearer JWT | 提交 `{idea_id}`，搜索并保存关联素材，返回 material 数组，无匹配时返回 `[]` |

除健康检查外，返回格式为 `{code,msg,data}`。同步覆盖 idea、expansion、material、step、schedule、reminder。首次拉取使用 0，之后使用上次已成功写入 SQLite 的拉取游标。服务端也记录提交时间，使离线设备迟到的旧修改仍可被其他设备发现。同一记录按业务 `updated_at` 取较新版本，软删除优先，时间相同保留服务端版本。系统提醒编号 `native_id` 仅在原设备有效。全部接口共享同一来源 IP 每滚动一分钟 60 次的限额。

要查看原生运行效果，用 HBuilderX 打开项目根目录，连接手机或启动模拟器，从「运行」菜单选择对应的 Android 或 iOS 设备。[DCloud 真机运行指南](https://uniapp.dcloud.net.cn/tutorial/run/run-app.html)

想法详情中的「AI 思路」提供通用、文章、视频、产品、学习五种模板，对应 `general/article/video/product/study`。重新生成会覆盖同一份思路，失败时可重试，离线时可读上次结果。客户端会先同步尚未上传的原文。模型返回的背景、要点、风险、下一步由后端校验，格式错误最多重试一次。

有扩写结果时，点「思维导图」可查看四个分支并把带「AI 生成」标识的 PNG 保存到相册。想法没有独立标题字段，中心节点使用原文首个非空行的首句。

手机系统分享面板中的「AI速记」接收文本和网页链接。Android 收到分享后打开应用，iOS 分享扩展先保存到本机共享容器，下一次打开应用时自动进入收集箱。未登录时暂存到登录后，已绑定账号的分享仅导入该账号。每次分享最多 2000 字。

从系统小组件列表添加「今日待办」，可离线看到和日程页相同的前三条。点待办打开对应日程实例，点「记一笔」进入记录页。Android 安装包需要包含 `suji-system` 原生插件；iOS 离线宿主还需嵌入两个扩展并配置 App Group。[iOS 扩展接入](./native/ios/README.md)

详情页的「流程」支持 AI 拆解、手动编辑与拖动排序。转日程时先选起始时间并预览，可逐条调整起止时间。确认后，应用同时保存日程及提前 10 分钟的本地通知提醒。步骤与关联日程的首次打卡联动。

详情页的「找题材」从原文提取 3 个检索词，默认搜索央视网公开图文，每词最多取 5 条。模型只根据搜索返回的内容写摘要。后端逐字核对标题、来源、日期与原始 HTTPS 网址，并在保存前检查国内站点原文能否打开。央视网发布时刻按北京时间读取。来源缺少发布日期时，卡片显示「日期未知」。已保存的素材可离线查看和逐条删除。

在「日程详情」可选择通知或闹钟、调整时间或关闭提醒。「我的 → 提醒权限」检查系统设置，也可离线查看华为、小米、OPPO、vivo 的设置指引。App 在启动和返回前台时从 SQLite 恢复当前账号尚未到点的提醒。已展示的通知保留到用户处理，关闭提醒、完成或删除日程都会撤销对应登记。每条提醒按其独立的 `remind_at` 触发一次，稍后提醒以用户按按钮的时间为基准。

移动端安装包需包含 `src/uni_modules/suji-reminders` 原生插件。Android 使用精确闹钟和全屏通知，锁屏全屏展示受闹钟通道与系统授权控制。iOS 使用系统本地通知与随包 24 秒铃声，系统要求自定义通知声短于 30 秒。运行 `npm run test:reminders` 可复验 SQLite 重排、操作回写、撤销和账号隔离。[Apple 通知声音](https://developer.apple.com/documentation/usernotifications/unnotificationsound) · [Android 精确闹钟](https://developer.android.com/develop/background-work/services/alarms)

真机调试应使用包含该插件的自定义基座或离线签名包。`npm run build:app` 导出前端及 UTS 原生工程资源。使用离线 SDK 时，按项目自己的 DCloud AppID、包名及签名配置 AppKey。[DCloud 离线 AppKey 配置](https://nativesupport.dcloud.net.cn/AppDocs/usesdk/appkey)

「日程」可按月或周查看，点击日期即可查看当天安排。手动和流程生成的日程都可编辑、打卡或软删除。每天、每周和每月重复的日程可逐次打卡，标题与时间的编辑应用于整个系列。每月 31 日的安排会跳过没有 31 日的月份。运行 `npm run test:calendar` 可复验跨年、月末、逾期和离线打卡。

运行 `npm run test:workflow` 可复验依赖环、跨天预览、确认回滚和双向勾选。在进程环境中提供独立测试库的 `DB_HOST`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` 并设置 `AI_SUJI_MYSQL_TEST=1` 后，还会验证拆解接口写库、用量与增量同步。

每日额度按用户和 UTC 自然日计算，扩写、拆解和研究合计 20 次。一次找题材通常占 1 次额度，查无结果也记录本次检索；模型输出校验失败后的第二次调用另记一次。语音转写单列为 `asr`，不占上述额度。超额时返回 HTTP 429、业务码 `42901`。运行 `npm run test:asr` 和 `npm run test:research` 可验证时长、断网重试、来源校验和缓存。连接已迁移的独立测试库并设置 `AI_SUJI_MYSQL_TEST=1` 可验证实际写库与额度。

## 目录说明

| 路径 | 职责 |
| --- | --- |
| `src/pages/` | 页面展示与用户交互 |
| `src/components/` | 可复用的界面组件 |
| `src/services/` | 业务逻辑与流程编排 |
| `src/api/` | 后端请求封装 |
| `src/repositories/` | 按模型和用户封装本地 SQLite 增删改查，`db/` 管理连接、事务与迁移 |
| `src/store/` | Pinia 状态管理 |
| `src/utils/` | 通用工具函数 |
| `src/types/` | 共享类型定义 |
| `src/static/` | 图片等静态资源 |
| `server/` | Express 后端源码、配置及环境变量示例 |

## 数据库与迁移

Android 和 iOS 在 App 启动时打开 `_doc/ai-suji.db`。冷启动和首次仓储调用共用初始化任务。升级时按 `PRAGMA user_version` 顺序执行 `src/repositories/db/migrations.ts` 末尾新增的迁移。建表和版本号在同一事务中提交。H5 预览跳过原生数据库初始化。

页面经 service 调用相应仓储。例如 `ideaRepository.create(userId, { content })` 写入想法，`get(userId, id)`、`list(userId)`、`update(userId, id, patch)` 和 `remove(userId, id)` 分别负责查询、列表、更新及软删除。每次调用使用当前用户的 UUID，离线操作只访问本地文件。

服务端使用已建好的 MySQL 8 数据库（8.0.16 及以上）。在 `server/.env` 填写四个 `DB_*` 配置后，从项目根目录执行 `npm run db:migrate -w @ai-suji/server`。每次变更在 `server/migrations/` 新增一个连续编号的 SQL 文件，例如 `002_idea_index.sql`。执行器校验已应用文件的摘要，并串行运行迁移。MySQL DDL 会隐式提交，新增迁移须可在中断后重复执行。

在 Node.js 24 下运行 `npm run test:sqlite` 可复验迁移回滚、写入进程被强制结束后的恢复、七个模型的离线操作和用户隔离。测试用原生桥适配器把仓储请求交给本机的文件型 SQLite。Android 9 模拟器使用 App-Plus 基座，验证了冷启动建表、强制停止后读取原记录，以及断网时的想法增删改查。

`npm run test:auth` 验证登录、令牌和 IP 限流。`npm run test:sync` 验证本机同步队列、断网重试和账号切换。将 `server/.env` 指向已迁移的 MySQL 测试库并设置 `AI_SUJI_MYSQL_TEST=1` 后，同一命令也会验证真实接口的六表读写、冲突及隔离。

## 环境变量

需要本地配置时，将根目录的 `.env.example` 复制为 `.env`，将 `server/.env.example` 复制为 `server/.env`。前端的 `VITE_*` 变量会进入客户端构建产物。密钥和密码只填入本机的 `server/.env`。

| 文件 | 变量 | 用途 |
| --- | --- | --- |
| `.env` | `VITE_API_BASE_URL` | 客户端可访问的后端基础地址。真机联调时填写手机可访问的开发机地址 |
| `server/.env` | `DB_HOST` | MySQL 主机地址 |
| `server/.env` | `DB_USER` | MySQL 用户名 |
| `server/.env` | `DB_PASSWORD` | MySQL 密码 |
| `server/.env` | `DB_NAME` | MySQL 数据库名称 |
| `server/.env` | `JWT_SECRET` | 签发与校验登录令牌的密钥 |
| `server/.env` | `SMS_DEBUG_CODE` | 开发期短信登录的固定调试码 |
| `server/.env` | `LLM_API_KEY` | 大语言模型服务密钥 |
| `server/.env` | `LLM_BASE_URL` | 兼容 Chat Completions 的服务地址；OpenAI 官方地址为 `https://api.openai.com/v1` |
| `server/.env` | `LLM_MODEL` | 后端调用的模型标识，例如 `gpt-4.1-mini`；省略时使用服务商的 `default` 别名 |
| `server/.env` | `SEARCH_API_KEY` | 留空时使用央视网公开搜索。选填 Brave Web Search 密钥后，检索范围限于央视网、人民网、新华网、中国政府网等国内站点 |
| `server/.env` | `ASR_API_KEY` | OpenAI 语音转写密钥。留空且 `LLM_BASE_URL` 指向 OpenAI 官方服务时，后端沿用 `LLM_API_KEY` |
| `server/.env` | `ASR_MODEL` | 可选语音转写模型，默认 `gpt-4o-mini-transcribe` |

## 提交规范

提交标题采用 `类型: 中文说明`，例如 `feat: 添加想法输入页`。可用类型为 `feat`（新功能）、`fix`（修复）、`docs`（文档）、`refactor`（重构）、`test`（测试）、`chore`（工程维护）。

在根目录运行 `npm run type-check`、`npm run lint` 和 `npm run format:check`，可分别检查类型、代码规则及格式。
