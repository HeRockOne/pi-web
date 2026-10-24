# Pi Web 主题配置指南

Pi Web 的全部颜色都走 14 个 CSS 变量。内置预设定义在
`lib/web-theme-types.ts` 的 `BUILTIN_THEMES`；用户自定义主题存放在
`~/.pi/agent/pi-web-themes.json`，设置 → 外观 里可以可视化编辑。

> **给 AI 的提示**：要生成一个新主题，把本文件连同下面的模板一起交给 AI，
> 让它只输出合法的 JSON 即可。约束见"规则"一节。

## 变量清单（缺一不可）

| 变量 | 用途 | 协调要求 |
|------|------|----------|
| `--bg` | 页面背景 | 全主题的基础面 |
| `--bg-panel` | 面板/侧栏/输入框外层 | 与 bg 同色相、略深（暗色略浅） |
| `--bg-hover` | 悬停态 | panel 与 selected 之间 |
| `--bg-selected` | 选中态 | hover 再深一档 |
| `--border` | 1px 描边 | 与 bg 同色相，明度贴近 selected |
| `--text` | 正文 | 对 bg 对比度 ≥ 12:1 |
| `--text-muted` | 次要文字 | 对 bg 对比度 ≥ 4.5:1 |
| `--text-dim` | 辅助/占位 | 对 bg 对比度 ≥ 3:1，只用于可弱化内容 |
| `--accent` | 主色：按钮、链接、激活态 | 对 bg 对比度 ≥ 4.5:1 |
| `--accent-hover` | 主色悬停 | accent 再深（暗色再浅）一档 |
| `--user-bg` | 用户消息气泡底色 | 中性偏 panel，不抢正文 |
| `--assistant-bg` | 助手消息底色 | 通常等于 bg |
| `--tool-bg` | 工具/代码面 | 介于 bg 与 panel 之间 |
| `--bg-subtle` | 极浅底纹（rgba 推荐） | 主色 3%–8% 透明度 |

状态色 `--ok` / `--err` / `--warn` 不随主题变化，定义在
`app/globals.css`，任何主题下都保持可读，**不要**在主题里覆盖。

## 设计规则（Codex 式协调）

1. **一套结构，一种色相**：面板、边框、悬停、选中全部由同一色相的
   中性灰阶构成，饱和度 ≤ 12%。主色只出现在 accent 与 bg-subtle。
2. **亮暗成对**：light 与 dark 必须同时给出，暗色不是亮色反相，
   而是同色相的低明度重建（bg 取 L≈7–9%，text 取 L≈90–93%）。
3. **灰阶五档等差**：bg → panel → hover → selected → border 明度
   依次递进约 2–3%，不允许跳档。
4. **主色克制**：accent 优先用 500–700 档的深色（亮色模式）/
   300–400 档（暗色模式）；荧光色、纯饱和色（#0f0、#ff0）一律不要。
5. **文字三档**：text / muted / dim 只拉明度，不换色相。

## 模板：可直接修改的自定义主题 JSON

写入 `~/.pi/agent/pi-web-themes.json`（与已有 `custom` 数组合并）：

```json
{
  "active": "sunset",
  "custom": [
    {
      "id": "sunset",
      "name": "暮霞",
      "description": "暖灰底 + 落日橘主色",
      "light": {
        "--bg": "#fdfbf9",
        "--bg-panel": "#f5f0eb",
        "--bg-hover": "#ece4dc",
        "--bg-selected": "#e2d7cc",
        "--border": "#e4dbd1",
        "--text": "#241f1a",
        "--text-muted": "#6a5f55",
        "--text-dim": "#a19385",
        "--accent": "#c2542a",
        "--accent-hover": "#a34420",
        "--user-bg": "#f6efe8",
        "--assistant-bg": "#fefdfc",
        "--tool-bg": "#f7f2ec",
        "--bg-subtle": "rgba(194, 84, 42, 0.05)"
      },
      "dark": {
        "--bg": "#151210",
        "--bg-panel": "#1d1916",
        "--bg-hover": "#28221d",
        "--bg-selected": "#322b24",
        "--border": "#312a23",
        "--text": "#eee6dd",
        "--text-muted": "#b5a598",
        "--text-dim": "#7e7166",
        "--accent": "#e8956b",
        "--accent-hover": "#f0b08d",
        "--user-bg": "#251f1a",
        "--assistant-bg": "#151210",
        "--tool-bg": "#191512",
        "--bg-subtle": "rgba(232, 149, 107, 0.08)"
      }
    }
  ]
}
```

校验规则（`sanitizeCustomTheme`）：`id` 匹配 `[a-z0-9][a-z0-9_-]{0,63}`
且不能以 `pi-` 开头（内置保留）；`name` 1–60 字符；14 个变量全部为
1–120 字符的字符串，且不含 `{ } < >`；多余的键被忽略，缺键的主题
整体拒收。保存后重启页面（或重新打开外观设置）生效。
