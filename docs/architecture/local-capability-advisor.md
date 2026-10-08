# Local Capability Advisor：长期架构基线

> **定位**：本文件记录稳定设计决策，不是每次测试的流水账。只有架构共识或验收标准改变时才修订。当前阶段、Runtime/Plugin 版本、执行证据和下一步，以 [Issue #5](https://github.com/solla-h/rdc-coding-runtime-docs/issues/5) 的最新记录为准。**本文件只有合并到 `main` 后才成为正式基线**。

## 1. 目标与责任边界

**最终用户体验**：普通 ChatGPT Web 会话在需要本机能力且工具选择不明确时，自动通过 Remote Desktop Commander（RDC）了解真实 Windows 环境，发现、理解并建议可用 Skill、CLI 或原生工具。用户无需事先枚举安装清单。交付的是满足用户实际结果与限制条件的**最佳可行方案**，而不是“找到一个相关 Skill”。

```text
ChatGPT Web Plugin / Skills（触发、任务约束、最终判断、执行权）
       │ 有界 task capsule；不传整段聊天或完整 Skill 目录
       ▼
RDC（本机连接、证据和执行通道）
       │
       ▼
how-to-use CLI（一次运行、唯一 RDC PID owner）
       │
       ▼
Pi Main（只读本机任务完成顾问）
       ├── capability_fanout（一次调用；只读 Skill Hub plan）
       │     └── deterministic shards（全量原始名称及完整 description）
       │              ├── disposable Pi Worker 1
       │              ├── disposable Pi Worker 2
       │              └── ...
       │           → 有来源的候选、覆盖率、失败分片
       └── 本机编辑器、OS、项目脚本、精确 CLI 等非 Skill 路径
                    ↓ 同一成功标准比较
              最小建议 + 本机证据 + 未验证前提
                    ▼
           ChatGPT Web 决定下一步；必要时再通过 RDC 执行
```

Pi Main / Workers **只做 discover → inspect → recommend**；不调用业务 API、不安装工具、不修改项目、不部署。ChatGPT 主 Agent 保留执行权及安全/授权判断。RDC、Plugin、Runtime、Pi、BrowserSkill 分别版本化，不把它们混成同一个版本。

## 2. Skill Hub：确定性、受管、非语义

1. **首选新 Skill 安装位置**：`~/.agents/skills/`。已有 Pi、Claude Code、Codex、Kiro 等客户端安装继续保留原位置；需要统一访问时由 Hub 创建受管链接，不复制/移动/删除来源。项目级 Skill 不自动提升为全局 Skill；客户端私有 `.system` Skill 不自动提升。
2. **默认源**：`~/.agents/skills`（目标）、`~/.pi/agent/skills`、`~/.claude/skills`、`~/.codex/skills`（排除 `.system`）、`~/.kiro/skills`，以及当前已安装且启用的 Claude Code 插件 Skills。需要时可为测试显式指定其它源。
3. **同名决议**：比较**整个 Skill 目录内容的指纹**；内容相同视为同版本，即使文件 mtime 不同，优先保留 Hub 既有副本；内容不同按目录内最新文件修改时间选取，再做稳定来源决胜。不通过仅比较 `SKILL.md` 或名字来判断版本。
4. **Bundle 原子性**：同一安装清单/发布家族（`installedVersion`、`buildCommit`，或显式 group）必须从同一源安装中**整组选择**，不跨版本挑选单个 Skill。客户端定向的安装元数据不计入目录指纹。安装清单冲突或不完整时 fail closed。
5. **文件安全**：`plan` 与 `shard` 只读；`sync` **只能显式触发**，实际用户目录绝不因 Advisor、Bootstrap 或测试自动同步。Windows 通过 Junction/受管目录链接汇聚；`~/.rdc/skill-hub/links.json` 记录所有权，锁避免并发 sync，只改动自身仍一致的链接。未受管目录、漂移链接、未知外部 symlink、源不完整均应阻止危险写入；部分失败可基于 ledger 对账。
6. **不建 Skill 数据库**：Hub 只处理磁盘和确定性选择；不承担语言理解、关键词路由、检索索引或模型选择。

源代码：[Skill Hub](../../runtime/lib/skill-hub.mjs)、[来源链接校验](../../runtime/lib/skill-hub-roots.mjs)、[使用说明](../../runtime/README.md)。

## 3. 全覆盖的 Pi Fanout 与质量决策

- 只读 Hub 生成稳定 ID（`skill:hub:<name>`）、来源、指纹、**完整原始 description**；按稳定顺序以默认 **262,144 UTF-8 bytes（256 KiB）/ shard** 确定性分片。不能为了限额静默截断单条；超大分片显式标记，分片总体覆盖率可验证。
- **不使用关键词、BM25、Embedding、向量数据库或其它语义预筛选**。每个 Worker 必须处理负责分片中的**全部**名称和描述，不是先筛候选再让模型看。
- Pi Main 由 `how-to-use --parallel-advisor` 一次性启动，通过 `capability_fanout` **一次**派发所有分片。Worker 是独立一次性 Pi 进程，使用 stdin 接受元信息，隔离 session / Skills / MCP / extensions / tools；不执行推荐的 Skill。默认并发 **4**，Advisor 可设为 **1/2/4/8**；每 Worker 默认 **120 s**，根请求总预算 **300 s**。
- Worker 每分片至多返回 5 个附说明的候选，返回 ID 必须在其负责的分片中；超出、无效 JSON、超时、异常退出、取消均保留为**缺失/失败覆盖**，不伪装为“没有匹配”或盲目重试。多个相关 Skill 可以组合，候选可来自不同分片。
- Main 必须先定义任务成功标准和硬约束，然后将 Worker 候选与**原生编辑器、OS 功能、项目内脚本、已核实 CLI**按同一标准比较。无 Skill 方案完全合法；“相关”不等于“可以达成结果”。只核实命令在 PATH 上，不能证明所需插件、渲染器、服务、身份认证或业务权限就绪。
- 选中 Skill 的完整说明通过精确 `capability_describe`（包括 `skill:hub:<name>`）按需重解到**当前 Hub 选择的来源**；禁止模糊 ID、路径穿越、越界读取或自动 sync。尚未核实的依赖和不足的分片覆盖必须明确报告。

源代码：[分片](../../runtime/lib/capability-shards.mjs)、[Worker 调度](../../runtime/lib/pi-advisor-fanout.mjs)、[Main 决策](../../runtime/lib/pi-advisor-decision.mjs)、[精确描述解析](../../runtime/lib/skill-hub-describe.mjs)。

## 4. 最小上下文、配置与执行纪律

- ChatGPT 的 Plugin/Skills **自然触发** RDC + Advisor；不要求最终用户提示 `how-to-use` 或先列安装清单。若 ChatGPT 原生工具/已连接插件已经完整满足需求，或已明确知道 CLI，无需为展示 Hub 而调用 Pi。
- `~/.rdc/MACHINE_CONTEXT.md` 只存长期机器事实与发现提示，不镜像全部 Skill 内容；发送给 Pi 的是有界目标、限制、工作区与问题。不要以 `rdc-cap context --json` 全量目录作为 `--parallel-advisor` 前置步骤；`rdc-cap` 的 `context/find/describe` 分别是**无语义排序**的有界目录、精确名称/ID 查找、精确描述。
- `~/.rdc/how-to-use/config.json` 是用户维护的 Router 配置源；Pi 专用目录中的 `models.json/settings.json` 是派生文件。不得读取/打印 API Key。Pi 通过窄的只读工具获得本机证据；普通 `how-to-use` 的单 Pi 兼容路径与显式 `--parallel-advisor` 路径分开；`--offline` 只提供确定性非排序目录。
- 一项耗时的 Advisor/外部操作只允许一个 `device + workspace + exact command + PID/session` owner；收到 PID 表示已启动，**不等于成功**。所有未知/非零副作用必须先核实再决定是否重试；不并发二次调查，不盲目轮询。Browser host 授权、用户确认与 Session 生命周期独立，不能绕过权限提示。
- **非目标**：自建 MCP Server、新 Agent Framework、Jev、长期语义数据库、复杂自定义权限系统、自动跑真实 `skill-hub sync`、把 Pi 改为第二个执行型 coding agent。

## 5. 阶段路线与不可混淆的证据

| 阶段 | 定义与已获得的证据 | 未覆盖的范围 |
| --- | --- | --- |
| **P0/P1** | Skill Hub、确定性全量分片和受管链接安全，代码与隔离单测已落地于 `main`；真实机器已跑**只读** `plan`（97 个选中 Skill）。 | 从未获授权对真实用户目录运行 `sync`；不能宣称用户目录已物理汇聚 |
| **P2** | Pi Main → disposable Workers 实现与实际模型调用已验证；默认 256 KiB 分片与覆盖状态，独立进程调度。 | 大量真实 Skills / 多轮生产尺寸分片压力、统计稳定性 |
| **P3** | 代表性测试覆盖 native/no-Skill、Skill+CLI、真实 no-match、**两个测试分片的 Main→2 Workers→Main**；精确 Hub ID 解析的源码测试已通过。 | 跨分片测试使用的是 **1100 bytes/shard** 测试夹具，不能当作 256 KiB 生产性能证明；新解析工具还需真实 Plugin E2E |
| **P4** | ChatGPT Web **fresh session** 自动触发、场景选择与发布兼容性。首轮自然 Markdown 预览有一次 PASS。 | 仍需无全量目录预载、专用 Skill、跨 Skill、无匹配等完整验收；处理宿主授权/会话连接问题；CLI help/version 无模型修复仍待审阅发布 |
| **P5** | 扩大真实规模与重复试验：正确率、约束满足、覆盖率、延迟、tokens/实际费用、异常处理/稳定性，对比原生方案与单 Pi 基线。 | 不能把一次代表性成功或服务商报告的 `$0` 视作统计可靠/免费 |

最终发布需按顺序：**人工合并已审阅源码 → 固定不可变 commit SHA → 对齐 Runtime / Bootstrap pin / ChatGPT Plugin 兼容声明 → 隔离预安装、静态及单测 → 保留 Router 配置哈希与旧版备份 → 安装后自检、CLI help/version 不触发 Pi、真实 fresh-session E2E → 验证回退路径**。不得基于移动的 `main` 安装，亦不得将不同组件版本的差异视为自动错误。

## 6. 证据来源与跨会话维护契约

- **决策依据**：[Issue #5](https://github.com/solla-h/rdc-coding-runtime-docs/issues/5)、[PR #17](https://github.com/solla-h/rdc-coding-runtime-docs/pull/17)（Hub / Fanout）、[PR #18](https://github.com/solla-h/rdc-coding-runtime-docs/pull/18)（任务完成优先）、[PR #19](https://github.com/solla-h/rdc-coding-runtime-docs/pull/19)（跨分片 / Hub ID）、[PR #20](https://github.com/solla-h/rdc-coding-runtime-docs/pull/20)（P4 CLI 帮助和版本修复提案）；[Runtime 文档](../../runtime/README.md) 与 [P3 验收矩阵](../../runtime/evaluation/README.md)。历史 README 中的“当前已安装”可能是编写时快照；以每次 live 环境核实和 Issue 最新记录为准。
- **任务状态账本**：Issue #5 记录每次迭代的已核实事实、准确 branch/commit/PR、验收 PASS/FAIL/INCOMPLETE、长期 PID owner、阻塞与下一步。不得把未完成 P4 写成 PASS。
- **本文件只存稳定设计/验收原则**。设计决策变动时先核对当前 `main` 和 PR，再在开发者拥有的分支修改本文件，通过 Draft PR 交人审阅；未经合并的文档只能是**候选基线**，不能冒充 `main`。
- **每次交接**：新会话先读 `main` 的本文件（若 Draft 尚未合并，则读对应 Draft PR 文档）、Issue #5 最新状态和相关 PR，再检查 live GitHub/RDC；结束时更新 Issue #5 的当前执行状态，只有设计变化才修改本文件。给用户的 Handoff Prompt **只含项目/Issue/PR 指针、当前进度、下一步**；下个会话不得依赖聊天历史或假设旧 PID/Browser Session 仍在。
