# AI Plugins

开源 AI 插件集合：存放自主开发的 AI 插件、使用文档与示例。

## 插件目录

| 插件 | 版本 | 平台 | 说明 |
| --- | --- | --- | --- |
| [AI-native SDLC](ai-native-sdlc-plugin/README.zh.md) | 0.0.1 | Claude Code | 通过 Skills、Hooks 和 CLI 支持开发流程、产物链、验证与发布门控。 |

## 安装 AI-native SDLC

在 Claude Code 中运行：

```text
/plugin marketplace add leoan698-tom/ai-plugins
/plugin install ai-native-sdlc@sdlc-playbook
```

然后在目标项目中运行：

```text
/ai-native-sdlc:sdlc-init
```

插件声明需要 Node.js 18+。安装命令使用本仓库地址；原始插件文档中的 `<your-org>/ai-native-sdlc-plugin` 是占位示例，请以此处为准。

- [中文文档](ai-native-sdlc-plugin/README.zh.md)
- [English documentation](ai-native-sdlc-plugin/README.md)
- [更新记录](ai-native-sdlc-plugin/CHANGELOG.md)
- [插件源代码](ai-native-sdlc-plugin/ai-native-sdlc)

## 仓库结构

```text
.claude-plugin/marketplace.json  # 本仓库的插件市场入口
ai-native-sdlc-plugin/          # 首个插件，保留原始压缩包中的文件结构
LICENSE                        # MIT 许可证
```

原始压缩包中的 CI 工作流保留在插件目录下，不会作为本仓库的 GitHub Actions 自动运行。本次导入保留原始文档中的功能与测试描述；这些描述不代表本仓库已完成运行验证。

## License

[MIT](LICENSE)
