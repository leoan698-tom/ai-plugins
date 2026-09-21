# AI Plugins for Claude Code

为 Claude Code 提供开发流程插件，把需求、计划、代码审查和验证组织成可追踪的工作流。

**中文** | [English](README.en.md) · [MIT](LICENSE) · [插件文档](ai-native-sdlc-plugin/README.zh.md) · [反馈问题](https://github.com/leoan698-tom/ai-plugins/issues)

## 开始使用 AI-native SDLC

前提：已安装 Claude Code，且插件运行环境的 `PATH` 中有 Node.js 18+。在目标项目中打开 Claude Code，依次输入：

```text
/plugin marketplace add leoan698-tom/ai-plugins
/plugin install ai-native-sdlc@sdlc-playbook
/ai-native-sdlc:sdlc-init
```

初始化会询问项目配置并写入策略与脚手架。完成后，先检查生成文件和实际检查输出，再开始开发。

## 为什么现在需要？

AI 加快了代码生成，团队仍需要知道：改动依据是什么、验证是否执行、发布前还缺什么。AI-native SDLC 用 Skills 组织步骤，用 Hooks 检查关键操作，让开发过程留下可检查的产物与证据。

## 从需求到评审

以下是工作流示意，不是运行结果：

```text
需求 intent.md → 规格 spec.md → 计划 plan.md → 代码与测试 → PR 与评审发现
```

| 你要做什么 | 插件入口 | 预期产物或用途 |
| --- | --- | --- |
| 把需求说清楚 | `/ai-native-sdlc:intent` | 记录目标与意图的 intent.md |
| 规划改动 | `/ai-native-sdlc:plan` | 包含改动文件的 plan.md |
| 验证改动 | `/ai-native-sdlc:verify` | 检查输出与验证证据 |
| 准备代码评审 | `/ai-native-sdlc:pr-review` | 按项目 REVIEW.md 预演评审 |

完整流程和使用边界见[中文文档](ai-native-sdlc-plugin/README.zh.md)。

## 插件目录

| 插件 | 声明版本 | 平台 | 用途 |
| --- | --- | --- | --- |
| [AI-native SDLC](ai-native-sdlc-plugin/README.zh.md) | 0.0.1 | Claude Code | 开发流程、产物链、代码审查、验证与发布门控 |

## 当前状态与使用边界

本仓库尚未完成干净环境安装与完整运行验证；插件文档中的测试描述和示例输出不代表本仓库版本的实测结果。

Hooks 依赖运行环境和启用配置。插件文档说明，缺少 Node.js 可能导致检查不阻断；请先阅读[控制边界](ai-native-sdlc-plugin/ai-native-sdlc/docs/escape-hatches.md)。导入的 CI 工作流位于插件子目录，不会作为本仓库的 GitHub Actions 自动运行。

## 文档与反馈

- [中文使用文档](ai-native-sdlc-plugin/README.zh.md) · [English documentation](ai-native-sdlc-plugin/README.md)
- [更新记录](ai-native-sdlc-plugin/CHANGELOG.md) · [插件源代码](ai-native-sdlc-plugin/ai-native-sdlc)
- [提交问题或建议](https://github.com/leoan698-tom/ai-plugins/issues)：请附操作系统、Claude Code 与 Node.js 版本、复现步骤和去除敏感信息后的错误输出。

## License

[MIT](LICENSE)
