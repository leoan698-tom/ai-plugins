# AI Plugins for Claude Code

Claude Code plugins that organize requirements, plans, code review, and verification into a traceable development workflow.

[中文](README.md) | **English** · [MIT](LICENSE) · [Plugin docs](ai-native-sdlc-plugin/README.md) · [Report an issue](https://github.com/leoan698-tom/ai-plugins/issues)

## Get started with AI-native SDLC

Requires Claude Code and Node.js 18+ on the plugin runtime's `PATH`. Open Claude Code in your target project, then enter these commands in order:

```text
/plugin marketplace add leoan698-tom/ai-plugins
/plugin install ai-native-sdlc@sdlc-playbook
/ai-native-sdlc:sdlc-init
```

Initialization asks for project settings and writes policy files and scaffolding. Inspect the generated files and actual check output before starting development.

## Why now?

AI speeds up code generation. Teams still need to know why a change was made, whether verification ran, and what remains before release. AI-native SDLC uses Skills to organize the work and Hooks to check key operations, leaving artifacts and evidence that can be inspected.

## From intent to review

Workflow illustration, not recorded execution output:

```text
intent.md → spec.md → plan.md → code + tests → PR + review findings
```

| What you need | Plugin command | Expected artifact or purpose |
| --- | --- | --- |
| Clarify a requirement | `/ai-native-sdlc:intent` | intent.md with goals and intent |
| Plan a change | `/ai-native-sdlc:plan` | plan.md listing files to change |
| Verify a change | `/ai-native-sdlc:verify` | Check output and verification evidence |
| Prepare code review | `/ai-native-sdlc:pr-review` | A review dry run using your REVIEW.md |

See the [plugin documentation](ai-native-sdlc-plugin/README.md) for the full workflow and its limits.

## Plugins

| Plugin | Declared version | Platform | Purpose |
| --- | --- | --- | --- |
| [AI-native SDLC](ai-native-sdlc-plugin/README.md) | 0.0.1 | Claude Code | Development workflows, artifact chains, code review, verification, and release gates |

## Status and limits

Clean-environment installation and full runtime verification have not yet been completed for this repository. Test descriptions and sample output in the imported plugin documentation are not verified results for this repository version.

Hooks depend on the runtime and enabled configuration. The plugin documentation notes that a missing Node.js interpreter can leave checks non-blocking; read the [control boundaries](ai-native-sdlc-plugin/ai-native-sdlc/docs/escape-hatches.md) first. Imported CI workflows live inside the plugin directory and do not run automatically as this repository's GitHub Actions.

## Documentation and feedback

- [English documentation](ai-native-sdlc-plugin/README.md) · [中文使用文档](ai-native-sdlc-plugin/README.zh.md)
- [Changelog](ai-native-sdlc-plugin/CHANGELOG.md) · [Plugin source](ai-native-sdlc-plugin/ai-native-sdlc)
- [Report a problem or suggest an improvement](https://github.com/leoan698-tom/ai-plugins/issues). Include your OS, Claude Code and Node.js versions, reproduction steps, and error output with sensitive information removed.

## License

[MIT](LICENSE)
