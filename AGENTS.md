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
