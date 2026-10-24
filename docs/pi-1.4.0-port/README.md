# pi 1.4.0 移植记录（MCP / 项目信任 / codemode 开关）

这些笔记是 2026-10 把上游 `agegr/pi-web`（pi 1.4.0 基线）移植进本 fork 时留下的调研与计划，
对应分支 `chore/pi-base-1.4.0` 的 22 个提交（已并入 `main`，v0.13.5）。

| 文件 | 内容 |
| --- | --- |
| `a-api-surface.md` | 上游新增的 API / 路由 / 类型面盘点 |
| `b-runtime-boundary.md` | 运行时边界（SDK internals、transport 工厂、session 生命周期） |
| `c-upstream-diff.md` | 上游 diff 逐文件判定 |
| `d-feasibility-report.md` | 可行性结论与取舍 |
| `e-upstream-mcp-spec.md` | 上游 MCP 功能规格 |
| `f-phase2-port-plan.md` | 第二阶段（Slice 1–4）文件级移植计划 |
| `g-slice-notes.md` | Slice 1–4 的完成记录与验证结论 |

上游原始文件副本（`upstream-stage/`、`upstream-tmp/`）已删除：需要时用
`git show upstream/main:<path>` 重新导出即可。
