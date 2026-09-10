# Pebble 架构设计（v1）

> 状态：**讨论稿（已并入 lab 级范围决策）**。本文把 `docs/v1-spec.md` 的需求转化为可落地的技术方案，作为两人 kickoff 讨论的对齐材料。
> 文中标注「✅ 已定/建议」的是确定或推荐选型，「🔲 待定」的是仍需共同拍板的开放项（汇总见第 10 节）。

> ## v1 范围决策（✅ 已定：全部按 lab 级）
> 原型为南大 GSE 2026 **lab1「会成长的个人助手」**，Pebble 仅把验证场景从 smail/ehall 换成 **Gmail/iCloud Calendar**。v1 需求强度**对齐 lab**：
> - **单用户**（lab 是单人助手）；多用户独立部署 + 隔离 → 留作后续扩展（§13）。
> - **lab 级恢复**：后台运行、不依赖桌面常开窗口、关页后状态不丢、重进可恢复；**不强求**「任意进程重启 exactly-once 续跑」。
> - **模型无关 = 可选**（lab 仅「模型不限」，非强制）：保留一个薄 `Provider` 抽象即可，不作否决项。
> - **保留**（lab 本就要求）：写操作前确认（展示关键字段+后果）、邮箱幂等（不重复处理/发送）、Rule/Skill 用 Git 管理。


## 1. 目标与范围

构建一个持续运行、可成长、跨工具执行的个人 Agent。本文覆盖：系统总体架构、技术栈、核心组件、关键机制（确认 / 幂等 / 恢复）、数据模型、模块边界与接口契约、里程碑与风险。不覆盖：具体 UI 视觉、详细 API 字段（留到实现期）。

设计遵循 **lab 级**约束（v1 范围见上方决策框）：
- 外部写操作先展示关键字段与后果、经用户明确确认后执行（lab#3）；执行内容 == 确认内容。
- 后台运行、不依赖桌面常开窗口；关页后任务状态不丢、重进可恢复（lab#4）。
- 邮箱同步 / 处理 / 发送幂等，不重复处理或发送同一封邮件（lab#2）。
- Rule/Skill/Workflow 可读、可改、经用户确认后投产、Git 版本化（lab）。
- 模型自主决策，不预设固定业务流程；但受确认 / 追问 / 幂等约束。
- **v1 单用户**；多用户隔离为后续扩展（§13）。

## 2. 参考 Hermes Agent：借鉴与差异

Hermes Agent 是自进化的本地 AI Agent 框架（Python + SQLite），与 Pebble 高度相似。我们**选择性借鉴**其成熟设计，对 lab 要求而 Hermes 偏弱的部分做**补强**。

| 能力 | Hermes 做法 | Pebble 取舍 |
| --- | --- | --- |
| Runtime 循环 | `run_agent.py` 主循环 + `context_compressor` | ✅ 借鉴「loop + 工具调用 + 上下文压缩」思路（引擎选型见 §6.1） |
| 工具调用 | MCP server + ~141 内置工具 | ✅ 采用 MCP 作为工具协议；工具集自建（Gmail / Calendar / Profile） |
| 记忆 | SQLite（WAL + FTS5），user / working / long-term 三层 | ✅ 借鉴分层 + FTS5；语义检索是否引入向量见 🔲 待定 |
| 能力成长 | `curator` / `/learn` + GEPA（execute-evaluate-optimize-learn） | ✅ 借鉴「成功流程自动沉淀为草稿」；但强制「草稿 → 用户确认 → 投产 → Git」 |
| 模型无关 | `ProviderProfile` | 🔸 **可选**：保留薄 `Provider` 抽象即可，非 v1 硬约束 |
| 后台运行 | 多端 gateway + cron | ✅ 借鉴后台 worker；关页后任务状态不丢、重进可恢复（lab 级，不强求任意重启 exactly-once） |

**Hermes 偏自主执行、Pebble 需补强的（lab 级）**：
1. **外部写确认**：写操作前展示关键字段与后果、明确确认后执行（lab#3），Hermes 无此强约束。
2. **幂等**：邮箱同步 / 处理 / 发送、日程创建的幂等键 + 执行记录（lab#2），防重复副作用。
3. *(后续扩展)* **多用户隔离**：v1 单用户；多租户留作扩展（§13）。

## 3. 设计原则

1. **状态可持久化、可恢复（lab 级）**：长任务与确认等待都落库；前端断开/关页不影响后端任务，重进可恢复。
2. **副作用先确认后执行、且只执行一次**：每个外部写操作绑定幂等键与执行记录。
3. **模型自主、框架最小**：不预设业务流程图，把决策交给模型；工程层只提供工具、记忆、确认与持久化能力。
4. **契约先行**：两人并行开发前，先固定模块间接口（§9）。
5. **可读可改可回退**：Rule/Skill/配置以文件 + Git 管理。
6. **引擎可插拔、能力即扩展点**：Agent 引擎（大脑）藏在 §9 契约之后，可替换；领域能力统一以 MCP 工具 + skill/rule 文件表达，新增能力 = 加一个工具/技能文件，不改核心（详见 §6.1 与 §13）。

## 4. 系统总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Web 前端（手机优先, PWA）                   │
│   对话式 UI · 预览/确认卡片 · Skill 草稿审阅 · 断线重连恢复       │
└───────────────▲───────────────────────────┬──────────────────┘
                │ REST + SSE/WebSocket        │
┌───────────────┴───────────────────────────▼──────────────────┐
│                       API / Gateway 层                         │
│   会话路由 · 流式推送 · 确认令牌校验 · 登录鉴权（单用户）         │
└───────────────▲───────────────────────────┬──────────────────┘
                │                             │
┌───────────────┴──────────────┐   ┌─────────▼──────────────────┐
│   Agent 引擎（轻量托管 SDK）   │   │      Task / Job 编排层       │
│  loop · 工具调用 · 上下文压缩  │◄──┤  任务状态机 · 幂等 · 重试 ·   │
│  · 追问/确认(approval)        │   │  lab 级恢复 · 后台 worker     │
└───┬─────────┬─────────┬───────┘   └─────────┬──────────────────┘
    │         │         │                      │
┌───▼───┐ ┌───▼────┐ ┌──▼─────────┐   ┌────────▼─────────────────┐
│Memory │ │ Provider│ │ Tool 层     │   │  外部服务集成             │
│/Profile│ │ (薄抽象)│ │ (MCP)      │──►│  Gmail · iCloud CalDAV    │
│FTS5    │ │ 可选    │ │            │   │  （Preview/Execute）      │
└────────┘ └────────┘ └────────────┘   └──────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│   能力成长：Rule / Skill / Workflow（文件 + Git 版本化）         │
│   草稿 → 用户审阅确认 → 投产 → 新会话继续应用                     │
└───────────────────────────────────────────────────────────────┘

持久化：SQLite（WAL）—— 任务/执行记录/记忆/会话；Git 仓库 —— 规则与技能文件
```

## 5. 技术栈选型

| 层 | ✅ 建议 | 理由 |
| --- | --- | --- |
| 语言（后端） | Python 3.12+ | 对齐 Hermes，复用其 runtime/memory/skill 思路 |
| Web 框架 | FastAPI（async） | 原生支持 SSE/WebSocket 流式对话与后台任务 |
| **Agent 引擎** | **Pydantic AI（默认）** / OpenAI Agents SDK（更快但偏锁定） | lab 级恢复下轻量托管即可；确认用引擎 approval + 平台层 TaskStore，无需重型 checkpointer（§6.1） |
| 数据库 | SQLite（WAL 模式） | 对齐 Hermes；单用户场景足够，运维简单。🔲 未来并发/恢复压力大时可换 Postgres |
| 全文检索 | SQLite FTS5 | 资料 / 记忆关键词检索，零额外依赖 |
| ORM | SQLModel / SQLAlchemy | 类型友好，便于定义任务与执行记录模型 |
| 工具协议 | MCP（Model Context Protocol） | 对齐 Hermes 与 lab；工具与引擎解耦，便于两人各自实现适配器 |
| LLM | 薄 Provider 抽象（model-agnostic 可选） | 保留可换模型的薄抽象即可；非 v1 硬约束 |
| 后台任务 | 持久化 Job/Task 表 + worker 循环 | lab 级：服务端跑任务、关页不丢、重进恢复；不引入重型队列（Celery） |
| 前端 | React + TypeScript + Vite，PWA | 移动 Web 体验、可离线重连；🔲 框架可换 Vue/Next |
| 前后端通信 | REST（操作）+ SSE/WebSocket（流式与状态推送） | 对话流式输出 + 断线重连恢复任务状态 |
| 规则/技能存储 | 文件 + Git（GitPython 或 shell git） | 满足可读、可改、版本化、回退 |
| 部署 | 单实例容器（Docker）/ 云主机 | v1 单用户单实例；多用户独立部署留作扩展 |

## 6. 核心组件

### 6.1 Agent 引擎方案（✅ 已定：轻量托管 SDK + 自建薄平台层）

Runtime 职责不变：根据意图与上下文自主组合工具、信息缺失即追问、外部写操作前触发确认中断。

原型 lab 明确允许「**基于现有 Agent 配置工具、脚本和技能**」。决策轴是 **谁拥有「大脑」（runtime / 记忆 / 技能进化）**；而 **平台层（后台运行 / 持久化 / 确认 / 幂等 / 手机 Web）仍需自建**——只是 v1 按 lab 级，平台层可以做得很薄。

| 维度 | A. 自建/作者化编排（自己写 loop，或用 LangGraph 这类提供持久化/中断积木的框架） | B. 基于现有 Agent Host 配置（lab 允许方式） | C. 嵌入托管引擎（如 Pydantic AI / OpenAI Agents SDK，引擎自动跑循环）+ 自建薄平台层 |
| --- | --- | --- | --- |
| 大脑归属 | 你 | 宿主（Claude Code / Hermes / 其它 MCP host） | 你（引擎是被你包起来、可替换的库） |
| 起步速度 | 慢（造轮子） | 最快（只配工具/skill/rule） | 快 |
| 后台持续运行、不依赖桌面常开窗口 | ✅ 自控 | ⚠️ 交互式宿主天然冲突；须选可 headless 的宿主 | ✅ 自控 |
| 手机 Web + 关页/重进恢复 | ✅ 自控 | ⚠️ 多由宿主决定，难定制 | ✅ 自控 |
| 确认 / 幂等 | ✅ 自控 | ⚠️ 宿主多半不提供，需外包一层甚至 fork | ✅ approval + 平台层 TaskStore |
| 与「模型自主、不预设流程」 | ✅ 契合 | 取决于宿主 | ✅ 契合（托管 loop 天然贴合） |
| 扩展新能力成本 | 中（自己接线） | 低但受宿主天花板与锁定 | 低（加 MCP 工具 + skill），平台层已支撑 |
| 主要风险 | 焦油坑（lab 警告）、维护全栈 | 锁定 + 触顶后被迫迁移/fork | 需自维护薄平台层 |

**直接回答「采用 B 设计会不会变大」**：主要是**减少**而非重构——大脑层被宿主接管；但平台与交付层（Tool、集成、任务/幂等/恢复、确认、前端）几乎不变。**风险在于交互式宿主难满足「后台持续 + 手机 Web + 关页恢复」，届时反要在宿主外再包一层，复杂度不降反升。**

**✅ 决策（已定，按 lab 级）**：v1 单用户 + lab 级恢复 → 走 **C 端轻量托管 SDK + 自建薄平台层**。
- 结构：领域能力统一为 MCP 工具 + skill/rule 文件；引擎藏在 §9 的 `Provider`/`Tool`/`TaskStore` 契约后（可替换）。
- 确认：用引擎的 approval 机制 + 平台层 `TaskStore` 持久化预览，**不依赖重型 checkpointer**。
- **不采用 B（交互式宿主）**，与「后台持续 + 手机 Web」冲突。
- 引擎默认 **Pydantic AI**（模型无关、`ApprovalRequired`）；若接受 OpenAI 锁定，**OpenAI Agents SDK** 起步更快。

#### 6.1.1 引擎子选型：「作者化(LangGraph)」 vs「托管 SDK 家族」

> 修正记录：曾误用 OpenAI Agents SDK 一个产品代表整个「托管引擎」类，得出「托管 SDK ⇒ 无持久化 + 锁单一厂商」的结论，**以偏概全，已撤回**。托管 SDK 是一个家族，多个同样具备持久化、人审、模型无关。

Python 后端可选引擎（按是否自带持久化 / 人审 / 模型无关）：

| 引擎 | 类型 | 持久化/跨重启恢复 | 人审(HITL) | 模型无关 | 备注 |
| --- | --- | --- | --- | --- | --- |
| LangGraph | 作者化状态图 | ✅ Checkpointer | ✅ interrupt/resume | ✅ | Python 下最成熟，控制最细 |
| CrewAI | 托管(角色式) | ✅ SQLite | ✅ @human_feedback | ✅ | 偏多智能体协作 |
| Dapr Agents | 托管(运行时托管生命周期) | ✅ Dapr Workflow | ✅ | ✅ | 需引入 Dapr，运维偏重 |
| **Pydantic AI** | 薄框架 | ⚠️ 原生无、可插拔 | ✅ ApprovalRequired | ✅ | **✅ v1 默认**：类型友好，持久层由平台 TaskStore 承担 |
| Google ADK | 托管 | ⚠️ 会话状态(需换 DB) | ✅ ResumabilityConfig | ⚠️ 偏 Google | |
| OpenAI Agents SDK | 托管(最薄) | ⚠️ 仅快照 | ✅ needs_approval | ⚠️ 偏 OpenAI | 🔸 起步最快，接受锁定可选 |
| Mastra / Vercel AI SDK | 托管 | ✅ / ⚠️ | ✅ | ✅ | TS 栈，与 Python 后端不符，仅列参照 |

**结论（已按 lab 级定档）**：v1 **不要求**「任意进程重启 exactly-once 续跑」，因此**无需自带重型持久化的引擎**；选轻量托管 SDK：
- ✅ **默认 Pydantic AI**：模型无关、类型友好、`ApprovalRequired` 对应确认；持久化由平台层薄 `TaskStore`(SQLite) 承担。
- 🔸 **OpenAI Agents SDK**：起步最快，但偏 OpenAI 锁定、仅快照持久化——团队接受锁定可选。
- LangGraph / CrewAI / Dapr 的强持久化在 lab 级下属**过度设计**；若未来提升到 spec 全强度，再按可插拔契约替换（§13）。

#### 6.1.2 约束必要性评估（lab vs Pebble spec vs 本稿拔高）

逐条溯源后的取舍（已并入顶部 v1 范围决策）：

| 约束 | 原版 lab | Pebble v1-spec | v1 取舍 |
| --- | --- | --- | --- |
| 写操作前确认（展示关键字段+后果） | ✅ lab#3 | 强化为 Prepare→Preview→Confirm→Execute、日程/邮件分别确认 | **保留**；确认用 approval + 持久化预览，不需跨重启的持久中断 |
| 幂等（不重复处理/发送） | ✅ lab#2 | 推广到日程 + 重试/刷新 | **保留** |
| 后台运行、不依赖桌面常开窗口、关页可恢复 | ✅ lab#4 | 同 lab 级（关页/刷新后可查看编辑待确认内容） | **lab 级**：关页不丢、重进可恢复；任意进程重启 exactly-once 留作未来增强 |
| 规则/技能 Git 化、可改可回退 | ✅ lab | ✅ | **保留** |
| 模型无关（Provider 抽象） | ⚠️ lab 仅「模型不限」=允许非强制 | ❌ spec 未提 | **可选**：薄抽象，不作否决项 |
| 多用户独立部署 + 隔离 | ❌ lab 是单人助手 | ❌ 原 spec 新增，已移除 | **v1 不纳入**：单用户（spec 已同步）；多租户留作扩展（§13） |

> ✅ **与 spec 已对齐**：`docs/v1-spec.md` 已按本决策移除「多用户独立部署 + 资料跨用户隔离」条目、改为单用户单实例；spec 的恢复要求本就是 lab 级，无需改动。两文档现已一致。

无论最终选哪个引擎，都通过 §9 的 `Tool` / `TaskStore` / `Provider` 契约与其余模块交互——这是引擎可替换、系统可扩展的前提。

### 6.2 Tool 层（MCP）

- 统一 `Tool` 协议：`name`、`input_schema`、`side_effect`（读 / 写）、`preview(args)`、`execute(args, idempotency_key)`。
- 写类工具（发邮件、建日程）**必须**实现 `preview` 与 `execute` 分离，`execute` 强制幂等。
- 首版工具：Gmail（同步 / 查询 / 线程关联 / 草稿 / 发送）、Calendar（查询 / 冲突检查 / 预览 / 创建）、Profile（检索 / 更新）、Memory（读写）、Skill（查询可用技能）。

### 6.3 外部服务集成

**Gmail**
- 🔲 同步方式：**Pub/Sub push（建议）** vs 轮询。push 满足「持续获取新邮件、自动启动 Agent」；轮询作为兜底。
- 幂等：以 `messageId` + `historyId` 去重，处理记录落库；发送以「草稿线程 + 幂等键」防重发。
- 线程关联：按 `threadId` 拉取历史往来补充上下文。
- 回复流程：生成草稿 → 用户编辑/审阅 → 确认 → 发送。

**iCloud Calendar（⚠️ 最高技术风险）**
- iCloud 无友好 REST API，需走 **CalDAV**；认证（app-specific password）、事件创建、冲突检查均比 Gmail 复杂。
- **建议 M0 先做技术验证 spike**：跑通「认证 → 查询日程 → 冲突检查 → 创建事件」。
- 写操作遵循 Preview → Confirm → Execute，创建以幂等键防重复。

### 6.4 Memory / 个人资料

- 分层（借鉴 Hermes）：working（当前任务上下文）、long-term（持久资料/偏好）、user（身份与配置）。
- 存储：SQLite + FTS5 关键词检索；🔲 是否引入向量做语义检索待定（首版可先 FTS5，验证不足再加）。
- **隔离**：v1 单用户；数据模型保留 `user_id` 作用域为未来多租户预留，v1 不实现跨用户隔离逻辑。
- 可溯源：回答与执行决策记录引用来源（lab#1：回答能定位到原文）。

### 6.5 能力成长（Rule / Skill / Workflow）

- **沉淀来源**：用户纠正 → Rule；重复成功流程 → Skill/Workflow。模型自主沉淀 + 用户显式触发都支持。
- **生命周期**：`草稿(draft) → 用户审阅/修改 → 明确确认 → 投产(active)`。未确认草稿在当前与新会话中**均不得**被应用或执行。
- **草稿必须展示**：触发词、必要参数、执行流程、安全性信息（涉及工具、外部副作用、确认要求）。
- **Git 化**：Rule/Skill 以文件存于 Git 仓库，投产/修改即 commit，支持 diff 与回退。
- **投产 ≠ 执行确认**：Skill 投产确认不替代每次外部写操作的单独确认。
- 借鉴 Hermes GEPA「execute-evaluate-optimize-learn」做迭代优化，但每轮优化产出仍是需确认的草稿。

### 6.6 任务编排：状态机 / 幂等 / 恢复（lab 级）

任务状态机（持久化，关页/重进可恢复）：

```
CREATED → PLANNING → (AWAITING_INPUT ⇄ PLANNING)     # 追问补全
        → PREVIEW_READY → AWAITING_CONFIRM
        → EXECUTING → DONE
                    ↘ PARTIAL_FAILED / FAILED          # 部分成功需在对话中说明各项状态
```

- **幂等**：每个外部写操作分配幂等键 `(task_id, op_type, target_hash)`；执行前查 `execution_log`，已完成则跳过并返回既有结果。
- **恢复（lab 级）**：任务状态落库；确认采用「**持久化预览 → 结束本次 run → 用户确认后新 run 从预览续跑**」模式，无需重型 checkpointer。关页/刷新后重进可恢复到最近状态。
- *(未来增强)* worker 异常退出后的 exactly-once 续跑（spec 全强度），留待需要时再上自带持久化的引擎。
- **部分失败**：如日程已建但邮件发送失败，Agent 在对话中准确说明每项操作当前状态。

### 6.7 确认机制（Preview → Confirm → Execute）

- 引擎决定写操作时进入 `PREVIEW_READY`，生成结构化预览（关键字段 + 实际副作用）持久化并推送前端。
- 用户可分别编辑日程与邮件草稿；编辑后对**最终预览**明确确认，前端获得一次性 `confirm_token`。
- 后端校验 token 与「确认内容 == 执行内容」一致后执行；日程创建与邮件发送**分别确认**。
- 确认状态落库，关页/刷新后重进可恢复到 `AWAITING_CONFIRM`（lab#4）。

### 6.8 Web 前端（手机优先）

- 对话式 UI + 流式输出（SSE/WebSocket）。
- 预览/确认卡片：展示关键字段与副作用，支持编辑与独立确认。
- Skill 草稿审阅界面：展示触发词/参数/流程/安全信息，支持修改与确认。
- 断线重连：重新进入拉取任务最新状态，恢复未完成的确认/追问（lab#4）。

### 6.9 部署 / 凭证（v1 单用户）

- **v1 单用户单实例**（lab 是单人助手）；数据模型保留 `user_id` 作用域为未来多租户预留（§13）。
- 🔲 凭证管理（Gmail OAuth、iCloud app-specific password）：加密存于实例本地或环境变量 / secret manager，**不入 Git**。

## 7. 关键数据模型（初稿）

| 表 / 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | id, config | v1 单用户；字段为未来多租户预留 |
| `sessions` | id, user_id, created_at | 对话会话 |
| `messages` | id, session_id, role, content, refs | 含来源引用 |
| `tasks` | id, user_id, session_id, state, context, updated_at | 可恢复任务 |
| `execution_log` | id, task_id, op_type, target_hash, idempotency_key, status, result | 幂等核心 |
| `confirm_tokens` | token, task_id, preview_hash, confirmed_at, consumed | 确认一致性 |
| `profiles` / `memories` | id, user_id, layer, content, fts_index | FTS5 检索 |
| `skills` / `rules` | id, user_id, status(draft/active), path, git_rev | 文件 + Git |
| `gmail_cursor` | user_id, history_id, last_sync_at | 同步去重 |

## 8. 端到端示例：「帮我处理这封活动邀请」

1. Gmail 新邮件同步（push）→ 创建 Task，自动启动引擎。
2. 引擎解析邮件（活动名/时间/地点/组织者/回复要求），按 `threadId` 关联历史往来。
3. 检索 Profile + 激活的 Rule，获取相关偏好。
4. 调 Calendar 工具查询目标时间冲突。
5. 信息缺失/歧义/冲突 → 进入 `AWAITING_INPUT` 向用户追问，不猜测。
6. 生成「日程预览」+「邮件回复草稿」→ `PREVIEW_READY`，展示关键字段与副作用并落库。
7. 用户分别编辑 → 分别确认（`confirm_token`）。
8. 校验一致后执行：创建 CalDAV 事件 + 发送 Gmail 回复，各带幂等键。
9. 报告结果，归档任务状态/来源/执行结果；若部分失败，准确说明各项状态。

## 9. 模块边界与接口契约（两人并行开发的关键）

**先固定以下契约，再各自开工，可互相 mock：**

- `Tool`：`{name, input_schema, side_effect, preview(args) -> Preview, execute(args, idempotency_key) -> Result}`
- `TaskStore`：`create / get / update_state / append_event / list_resumable`
- `ConfirmFlow`：`preview_payload schema · confirm(token) · execute-once 语义`
- `Memory`：`upsert(user_id, layer, content) · query(user_id, q) -> hits(含来源)`
- `Provider`：`chat(messages, tools) -> 模型响应（含 tool_calls）`
- `RuntimeEvent`：引擎 ↔ 前端的流式消息 schema（token / preview / ask / status）

**建议分工（可调整）：**

| 成员 | 负责模块 |
| --- | --- |
| A：Agent 内核与知识层 | 引擎接入与编排、Provider 抽象、Memory/Profile、Rule/Skill 沉淀与 Git 化、上下文压缩 |
| B：平台与集成层 | Task 状态机/幂等/恢复、Tool 层(MCP)、Gmail 集成、iCloud CalDAV 集成、确认后端、Web 前端、部署与凭证 |

> 边界偏重在 B，可按工作量把前端或 Memory 调整给 A。契约（§9 上半）是两人解耦的前提，应在 M0/M1 先冻结。

## 10. 决策状态

**✅ 已定（按 lab 级）**
1. **Agent 引擎**：轻量托管 SDK（默认 **Pydantic AI**；可选 OpenAI Agents SDK）+ 自建薄平台层；B 宿主不采用（§6.1.1）。
2. **恢复语义强度**：lab 级（关页不丢、重进可恢复）；任意进程重启 exactly-once 留作未来增强。
3. **多用户**：v1 单用户；多租户留作扩展（§13）。
4. **模型无关**：可选薄抽象，非否决项。

**🔲 仍待拍板**
5. **数据库**：SQLite（默认）vs Postgres（未来并发/恢复压力）。
6. **资料检索**：纯 FTS5（首版）vs 向量语义 vs 混合。
7. **Gmail 同步**：Pub/Sub push（建议）vs 轮询。
8. **前端框架**：React（建议）vs Vue vs Next。
9. **部署与凭证**：单机 Docker / 云主机；凭证存储与加密方式。
10. **LLM 选型**：用哪个/哪些模型，成本与能力权衡。
11. **Skill 自动沉淀的触发阈值与审核 UI 形态**。

## 11. 风险与技术验证（建议 M0 spike）

| 风险 | 等级 | 验证动作 |
| --- | --- | --- |
| iCloud CalDAV 集成（认证/创建/冲突） | 高 | spike：跑通认证→查询→冲突→建事件 |
| Gmail 持续同步 + 幂等去重 | 中 | spike：push/轮询打通，messageId 去重 |
| 确认状态跨关页/刷新一致性 | 中 | 原型：状态机 + confirm_token 落库恢复 |
| 引擎 approval 与平台 TaskStore 衔接 | 中 | 原型：Pydantic AI ApprovalRequired + 持久化预览续跑 |
| 模型自主决策的可控性（追问/确认） | 中 | prompt + 工具约束设计验证 |

## 12. 里程碑建议（tracer bullet 优先）

- **M0 技术验证**：CalDAV、Gmail 收发、引擎工具调用 + approval 三件最大不确定性各跑通一个最小 demo；冻结 §9 接口契约。
- **M1 端到端最小切片**：手动触发「处理活动邀请」单场景跑通，含 Preview→Confirm→Execute + 幂等。
- **M2 后台持续运行**：Gmail 自动同步触发 + 任务持久化 + 手机 Web 关页/重进恢复（lab#4）。
- **M3 能力成长**：Rule/Skill 草稿→确认→投产→Git 版本化→新会话继续应用（lab 能力成长）。
- **M4 收尾**：跑通 lab 五项能力 + 至少一条「愿意反复使用的完整流程」（lab#5）。

## 13. 扩展性设计（面向未来演进）

项目未来会扩展，架构须让「加能力」便宜、「换引擎」可能、「升容量」平滑。核心思路是**六边形/端口-适配器**：稳定的契约在内，可变的实现（引擎、外部服务、存储、前端）在外。

**1) 引擎可插拔**
- Agent 引擎只通过 §9 的 `Provider` / `Tool` / `TaskStore` / `RuntimeEvent` 契约接入，不直接耦合业务。
- 今天用轻量托管 SDK 起步；若未来要 spec 全强度恢复，可换成自带持久化的引擎（LangGraph 等），迁移面被契约挡住。

**2) 能力即扩展点（新增外部服务零改核心）**
- 一切领域能力统一表达为 **MCP 工具 + skill/rule 文件**（lab 与 Hermes 的共同扩展点）。
- 新增一个外部服务（如以后接入网盘、待办、智能家居）= 新增一个实现 `Tool` 协议的适配器 + 必要 skill，不动引擎 / 确认 / 幂等核心。
- 写类工具一律走 `preview/execute` 分离 + 幂等键，扩展自动继承安全约束。

**3) 平台层承载关键约束、与引擎解耦**
- 后台运行、任务状态机、幂等、恢复、确认流程在**自建平台层**，不依赖引擎/宿主提供。

**4) 存储与容量可升级**
- 存储抽象在 `TaskStore` / `Memory` 接口后：SQLite → 需要时切 Postgres；FTS5 → 需要时加向量做语义检索（混合）。

**5) 多用户演进（v1 之后）**
- v1 单用户；`user_id` 作用域已贯穿数据模型，未来要做「各用户独立部署」或「单实例多租户」时可平滑演进，并补足跨用户隔离与凭证管理。

**6) 技能/规则的可持续生长**
- Rule/Skill 以文件 + Git 管理，新会话继续应用；沉淀引擎（§6.5）随使用积累能力，扩展不依赖发版。

> 反模式（lab 警告的「焦油坑」）：把业务逻辑、确认逻辑、引擎调用、外部 API 细节糊在一起。一旦如此，每次扩展都要在泥潭里反复试错。上面的端口-适配器边界就是为避免这一点。

---

### 附：与 lab 五项能力的对应（自检）

| lab 能力 | 对应设计 |
| --- | --- |
| 1 个人数据库（索引/检索/定位原文） | §6.4 Memory/Profile（FTS5 + 来源引用） |
| 2 持续关联邮箱（同步/线程/草稿/确认发送/幂等） | §6.3 Gmail + §6.6 幂等 + §6.7 确认 |
| 3 办理事务（查询/材料/表单 + 保守确认） | §6.3 iCloud Calendar + §6.7 Preview→Confirm→Execute |
| 4 手机端联动（发起/查看/编辑/确认，不依赖桌面常开窗口） | §6.8 前端 + §6.6 lab 级恢复 |
| 5 能力组合（共享上下文，至少一条可复用完整流程） | §6.1 引擎 + §8 端到端示例 |
| 成功流程/纠正 → 可读可改、Git 管理、新会话生效 | §6.5 能力成长 |
