# Pi Web - Development Notes

> 本文件为启动时加载的规则（保持精简）。架构/陷阱/会话格式等厚内容已拆分到
> `docs/`，**按需读取**（涉及相关主题时 read 对应文件，不要猜）：
> - `docs/ARCHITECTURE.md` — 架构图、文件地图、设计决策与陷阱、dev 排障
> - `docs/SESSION-FORMAT.md` — 会话 .jsonl 格式、CSS 变量

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

Dev server 排障（锁、Turbopack、重启时机）见 `docs/ARCHITECTURE.md` 的 Dev Server Troubleshooting。

## 打包 / 发布

```bash
npm run pack   # = powershell -ExecutionPolicy Bypass -File scripts/release-pack.ps1
```

脚本流程：停 5566 dev → tsc → lint → 全量测试 → `next build` → `npm pack`，产物 `agegr-pi-web-<ver>.tgz` 在仓库根目录。

**端口规矩（重要）：**
- **30141 = next dev server（agent 会话端口），打包绝不涉及、绝不停、绝不传 `-DevPort 30141`**
- 脚本只停 5566（`-DevPort` 参数默认 5566，仅当另有 dev 实例时才需覆盖）
- 安装全局包 `npm install -g ./agegr-pi-web-<ver>.tgz` 后，30141 若还起着旧代码，需重启 dev server 才生效（重启前先确认无未保存会话）

**版本 bump：**
- `npm version patch --no-git-tag-version`（不建 tag）
- **先确认 package.json 与 package-lock.json 的 version 一致**，不一致会跳级（实例：0.11.2 → 0.11.4）
- 打包后按惯例提交 `chore(release): v<ver>`

**其他：** 打包会跑 `next build` 污染 `.next/`，打包后 `npm run dev` 如异常需重启 dev server。
