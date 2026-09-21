# ai-native-sdlc

把 [AI-native SDLC playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook/introduction)
的政策做成**确定性门禁**的 Claude Code 插件——而不是做成建议。

**Skill 承载知识，hook 承载强制。** 课程对这个区别说得很直白：skill 让违规罕见，
hook 让违规几乎不可能。这里的一切设计都从认真对待这句话出发。

[English](README.md)

---

## 它到底保证什么

先读这一节。一个边界不清的控制，会被信任到超出它能力的地方。

> **对 agent 是硬的。** `PreToolUse` 的 deny 在任何权限模式检查**之前**触发，
> 所以 `bypassPermissions` 和 `--dangerously-skip-permissions` 都绕不过。
> 会话无法把自己的权限放宽到越过一个 deny，也无法写 hook 进程的环境变量——
> 因此发布授权无法在会话内部伪造。
>
> **对人不是硬的。** 除非组织下发 managed settings，否则 `/plugin disable`、
> `disableAllHooks` 和 `--settings` 始终可用。而且 **node 缺失时 hook 退出码是 127，
> 运行时把它当作*非阻断*错误——于是每个门禁静默 fail-open**。
>
> **所以在没有 managed settings 的情况下，CI 里的 `sdlc-verify` 才是主控制。**
> 它按 diff 重跑同一批确定性检查，不信任何本地状态，因此在 hook 从未运行过的机器上依然成立。

全部绕过路径及其暴露信号见
[escape-hatches.md](ai-native-sdlc/docs/escape-hatches.md)。
课程 83 条政策逐条对应实现机制（**包括本插件没有实现的 28 条**）见
[ENFORCEMENT-MATRIX.md](ai-native-sdlc/docs/ENFORCEMENT-MATRIX.md)。

## 安装

```text
/plugin marketplace add leoan698-tom/ai-plugins
/plugin install ai-native-sdlc@sdlc-playbook
```

然后在要保护的仓库里：

```
/ai-native-sdlc:sdlc-init
```

它会探测技术栈、就仓库特定的值访谈你、写入策略文件和脚手架——最后**证明门禁真的会触发**，
方法是把合成 payload 重放进真实 hook：

```
PASS  credential in a diff is denied                     expected deny, got deny
PASS  push to the default branch is denied               expected deny, got deny
PASS  production deploy without authorization is denied  expected deny, got deny
PASS  test edit during a locked fix is denied            expected deny, got deny
PASS  an ordinary source edit is allowed                 expected allow, got allow

11/11 gates fired as expected. The enforcement layer is live.
```

"配置看起来对"不是控制在线的证据。这个才是。

**要求 hook 进程的 `PATH` 上有 Node 18+**。这一条是承重的：解释器缺失会让每个门禁静默失效。

## 产物链

每个阶段以提交一份产物结束，下一个阶段从读它开始。commit 链就是审计轨迹。

```
intent.md → spec.md → plan.md → diff + 测试 → PR + 评审发现
```

| 命令 | 阶段 | 作用 |
|---|---|---|
| `/ai-native-sdlc:intent` | Plan | 先头脑风暴，再用**发起人自己的话**写 `intent.md` |
| `/ai-native-sdlc:spec` | Design | 需求与设计一次完成，受你的政策 skills 约束，**冲突必须标记** |
| `/ai-native-sdlc:plan` | Build | 先拷问计划，再写出含"会改哪些文件"的 `plan.md` |
| `/ai-native-sdlc:fix` | Test | 先写失败测试、提交，之后测试文件转为只读 |
| `/ai-native-sdlc:verify` | Test | 跑检查、**粘贴字面输出**，再由独立 verifier 复核 |
| `/ai-native-sdlc:pr-review` | Deploy | 按你的 `REVIEW.md` 在本地预演评审 |
| `/ai-native-sdlc:release` | Deploy | 把发布准备到生产门禁为止，**绝不越过** |

另有 `sdlc-doctor`、`sdlc-status`、`gates`、`review-tune`。

## 门禁

**永远硬性**——完全不受 `enforcement_level` 影响，且内部错误时 **fail-closed**
（因为原生 Windows 下面没有 OS sandbox，这些 hook 是唯一一层）：

- 凭据进 diff（拦截消息只报模式名和行号，**绝不回显密钥**）
- 密钥文件读取——文件工具**和** shell 两条路都堵
- 无具名发布授权的生产部署
- push 受保护分支、强推、`--no-verify`、自批、自合
- fix 模式测试锁——文件工具、shell、以及每回合末的哈希比对，三层
- 生成/冻结/锁文件/迁移/基础设施路径
- 对插件自身配置的写入
- 只读 agent 类型的写入

**档位相关**——`standard`（默认）阻断，`advisory` 只警告：
artifact 结构、plan 与实现同步、验证证据、网络出口。

用 `enforcement_level` 调节。**这个旋钮是卫生层面的推进档位，永远碰不到永远硬性的那一组。**

## 验证证据

已核实：shell 工具的 `tool_response` 只有 `stdout`/`stderr`/`interrupted`，**没有 exit code**。
所以 `PostToolUse` 钩子无法知道测试是否通过，只能匹配输出文本——
而文本匹配可能**记下一个假绿**，那就是对整个门禁的静默绕过。

因此 Stop 门禁是混合式的：

1. **记录**——verify 命令跑完后判定，连同工作树的**内容哈希**一起存
2. **信任**——树仍哈希到同一指纹时，什么都不重跑
3. **重跑**——树变了，就亲自执行命令拿真 exit code

用内容哈希而非 mtime：格式化钩子会在编辑后改写文件，用 mtime 会让每条绿记录瞬间失效。

## CI

```yaml
- run: node ai-native-sdlc/bin/sdlc-verify.mjs --base origin/main --head HEAD
```

**把它设为必需状态检查。** 它按 diff 重跑凭据、受保护路径、被禁用的测试、
`CLAUDE.md` 长度、artifact 结构、plan 漂移和 artifact 作者行，不信任何本地状态，违规 exit 1。

## 可移植性

所有 hook 都是 exec form（`node` + `args`），因此**任何平台上都不经过 shell**：
没有 Git Bash / PowerShell 分叉、没有引号陷阱、没有 `.cmd` shim 问题，
也**不依赖 `jq`**——`jq` 缺失会 exit 127，那是 fail-open。
shell 门禁一律匹配 `Bash|PowerShell`，因为没装 Git Bash 的 Windows 上根本不注册 Bash 工具。
路径先规范化再匹配。`.gitattributes` 锁定 LF，Windows checkout 无法破坏脚本。

已在 windows-latest、macos-latest、ubuntu-latest 上测试。

## 配置

**插件里没有任何仓库特定的值。** 三层：

| 层 | 位置 | 谁改 |
|---|---|---|
| 组织 | 插件 `userConfig`（9 个标量键）| 启用时提示，或 managed settings |
| 仓库 | `.claude/sdlc/config.json` | 团队，走 PR 评审 |
| 个人 | `.claude/sdlc/config.local.json`（gitignore）| 你——**只能收紧，不能放松** |

"只能收紧"是结构性保证：保护性列表是并集而非替换，档位只能往上调。
想比团队更严的人有地方去；想更松的人必须去改一个受评审的文件。

## 开发

```bash
cd ai-native-sdlc
npm test                       # 80 个测试，包含真实 hook 进程
node tests/portability-lint.mjs
node scripts/selftest.mjs      # 证明门禁会触发
claude plugin validate . --strict
```

本地循环：`claude --plugin-dir ./ai-native-sdlc`，然后 `/reload-plugins`。

## 许可

MIT。
