# AGENTS.md

## Pebble

持续运行的个人 Agent，首版由单个 Agent 按用户目标组织工具调用。

## Development

## Architecture

## 文档

- `docs/v1-spec.md`：第一版需求范围、产品行为、执行约束与验收场景。

涉及功能、架构或执行流程的工作，先阅读相关约定。
若用户要求与现有约定冲突，先明确差异，不自行改变产品行为。

## 自主执行边界

以下工作无需逐步审批：

- 在已授权范围内完成实现、必要验证及相关问题修复。
- 自行决定不改变需求范围和产品行为的常规实现细节。

以下情况先向用户明确并获得确认：

- 改变需求范围或既定产品行为。
- 执行未获授权的破坏性操作或真实外部写入。

## 其他约定

- 进行 git commit 时不加 `co-authored-by`，除非是对方明确要求。
- 进行 git commit 时直接提交到当前分支。
- commit message 约定：`[模块] 功能描述`，使用英文，例如 `[Gmail] Support email thread association`。
