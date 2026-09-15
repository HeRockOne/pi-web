# 侧边栏 Session 列表改为「项目文件夹树」显示 — 改动方案

> 目标：侧边栏的对话 session 列表从「顶部项目选择器 + 平铺行」改为「文件树样式」——**项目 = 文件夹层**，项目下挂会话，会话内部 fork / subagent 按父子关系展开/折叠、按层级缩进。
> 已确认：保留现有虚拟滚动（固定行高 54px 的 window 渲染）。
> 已确认（用户 m00115）：① 项目内会话保留 fork/subagent 父子嵌套；② 顶部项目选择器（CWD 下拉）**移除**，改由项目文件夹行承担选择职责。

```
▼ 📁 pi-web-main                  ← 项目文件夹行（可折叠，点击=选中该项目）
│  ▼ 💬 会话A「修复登录bug」 12条 3分钟前 ●
│  │  ├─ ▶ 子会话(Explore) 2条
│  │  └─ ▶ fork「改用方案B」 4条
│  ▼ 💬 会话B「重构路由」 8条 1小时前
▸ 📁 项目 b
▸ 📁 项目 c
```

## 现状（改动前）

```
components/SessionSidebar.tsx
├─ L19   SESSION_LIST_ITEM_HEIGHT = 54（固定行高）
├─ L21   getSessionListIndices() —— 虚拟滚动取可见行区间
├─ L960  recentProjects = getRecentProjects(allSessions)（按最近活动倒序）
├─ L971  projectActivity = getProjectActivity(...)（每项目 running/unread 计数）
├─ L1011 filteredSessions = selectedProject ? sessionsForProject(...) : allSessions
├─ L1043 sessionFamilies = listSessionFamilies(filteredSessions)  ← 平铺来源
├─ L1120-1330  CWD 选择器下拉（项目列表 + 过滤 + 默认目录 + 自定义路径）
├─ L1740-1850 列表渲染区：sessionFamilies.map()，每行一个 family
└─ L2074 SessionItem() —— 已带 depth / hasChildren / collapsed / onToggleCollapse
```

关键事实：
- `lib/session-family.ts` 的 `listSessionFamilies()` 把每个 root 与其全部 subagent 后代**压平成一个 family**，列表只显示一行。
- `lib/session-tree.ts` 的 `buildSessionTree()` 已存在：fork 保持为根，只有 subagent 嵌套（有独立测试 session-tree.test.mjs）。
- fork 父子关系：`relation: { kind: "fork"; originSessionId }`；subagent：`relation: { kind: "subagent"; parentSessionId }`；另有顶层 `parentSessionId` 字段。
- `SessionInfo.cwd` 是必填，故每个会话都能归属某项目（`projectRoot ?? cwd`），不会有孤儿会话。
- `SessionInfo` 不暴露 `cwd` 以外目录信息给行渲染所需 —— 无需改类型。

## 改动点

### 1. `lib/session-tree.ts` — fork 也嵌套 + 新增拍平函数

**buildSessionTree 改动**（一行逻辑）：
```ts
// parentOf 构建时同时认 fork 和 subagent：
if (session.relation?.kind === "subagent") parentOf.set(session.id, session.relation.parentSessionId);
else if (session.relation?.kind === "fork" && session.relation.originSessionId)
  parentOf.set(session.id, session.relation.originSessionId);
```
- 孤儿（父不在列表/环）仍回退为根，`resolveAncestor` 环保护逻辑不动。
- 每层按 `modified` 倒序排序不动。

**新增拍平函数**（树 → 虚拟滚动输入）：
```ts
export interface SessionTreeRow {
  kind: "session";
  session: SessionInfo;
  depth: number;        // 树内深度（0 = 项目下的顶层会话）
  hasChildren: boolean;
  collapsed: boolean;   // 该节点自身是否折叠（collapsedIds 命中）
}

export function flattenSessionTree(
  roots: SessionTreeNode[],
  collapsedIds: ReadonlySet<string>,
): SessionTreeRow[]
```
规则：迭代式 DFS 先序遍历（父行索引恒小于子树行）；`collapsedIds` 命中 → 跳过其子树；深度 >1500 不爆栈（显式栈，同 buildSessionTree 先例）。

### 2. `components/SessionSidebar.tsx` — 渲染改走「项目 → 会话树」

**行模型**（一维数组喂虚拟滚动，行高统一 54）：
```ts
type SidebarRow =
  | { kind: "project"; project: RecentProject; depth: 0; hasChildren: boolean; collapsed: boolean; projectSessions: SessionInfo[] }
  | { kind: "session"; session: SessionInfo; depth: number; hasChildren: boolean; collapsed: boolean };
```

- 新增 state：`collapsedProjectKeys: ReadonlySet<string>`、`collapsedSessionIds: ReadonlySet<string>`（默认空 = 全展开）。
- 新增 `sidebarRows`（useMemo，依赖 allSessions/recentProjects/两个折叠集合）：
  ```
  for project of recentProjects:
      projectSessions = sessionsForProject(allSessions, project.key)
      push 项目行（collapsed 由 collapsedProjectKeys 决定）
      if 折叠 或 无会话 → continue
      tree = buildSessionTree(projectSessions)
      for row of flattenSessionTree(tree, collapsedSessionIds):
          push { ...row, depth: row.depth + 1 }   // 项目行之下 +1 层缩进
  ```
- 替换 L1043：`sessionFamilies = listSessionFamilies(filteredSessions)` → `sidebarRows`；`filteredSessions` 随之删除。
- 虚拟滚动不变：`getSessionListIndices(sidebarRows.length, ...)`；focused 索引 = `sidebarRows.findIndex(r => r.kind==="session" && r.session.id === focusedSessionId)`。
- 渲染区 L1740-1850 改两分支：
  - **project 行** → 新组件 `ProjectFolderRow`（本文件内尾部）：文件夹图标、`PathLabel(displayCwd(root, homeDir))` 两行布局（路径 + 会话计数 + running/unread 指示器）、折叠箭头（同 SessionItem 样式）；选中态 `key === selectedProject?.key`；点击行体 = `selectProjectRoot(key)` → `setSelectedCwd(project.root)`；箭头仅折叠/展开（stopPropagation）。
  - **session 行** → `SessionItem`（参数全齐，无需改签名）：`session` 传该行自身（不再是 family.root），`depth`、`hasChildren`、`collapsed`、`onToggleCollapse` 传入；running/unread/选中按 `row.session.id` 单判。
- **选中自动展开祖先链**（useEffect 监听 selectedSessionId）：展开所在项目文件夹 + 沿 `parentSessionId`/`relation` 上溯的所有会话祖先，保证选中项可见。

### 3. 移除顶部 CWD 选择器（用户确认）

删除 L1120-1330 的 CWD 下拉块（项目列表按钮 + AnimatedDropdown + 过滤输入 + 默认目录 + 自定义路径）。随之清理死代码（避免 lint unused）：
- state：`dropdownOpen`、`projectFilter`、`customPathOpen`、`customPathValue`、`customPathError`、`customPathValidating`、`dropdownRef`
- 函数：`commitCustomPath`、`handleCustomPathClick`、`handleDefaultCwd`、`visibleProjects`、`showProjectFilter`、`hasOtherWorkspaceActivity`
- import：`DirectoryPicker`（仅 customPathOpen 用）
- **保留**：`recentProjects`、`projectActivity`（ProjectFolderRow 复用）、`displayCwd`/`PathLabel`、worktree 切换器（在 header，不动）。
- **额外移除**：顶部 pinned「active elsewhere」跨项目区（crossProjectActiveSessions + 其渲染）——树中每个项目文件夹自带 running/unread 指示，不再需要；`validatedProject` state/接口/projectFor 分支、`showProjectActivity` 函数一并删除。

### 4. SessionItem 微调（图标区分）

已实现：`depth > 0` 时按 relation 区分 —— fork 显示分支图标（muted 色，复用 worktree branch SVG），subagent 保持原机器人图标（accent 色）。

#### 4b. 视觉分层（用户反馈扁平后追加）
已实现三类层级手段（非阴影/边框）：
- **引导线**：`flattenSessionTree` 新增 `guideLayers`（贯穿行高的竖线）/`tailLayers`（半竖线 + L 形接头）元数据；渲染时按 `lineX(layer) = 14 + layer*18 + 8` 绝对定位画线（色 `var(--border)`）。数据生成规则：非末尾兄弟的父层线传给子树贯穿；叶子行的贯穿线全部转为尾线（L 收尾）；项目层（layer 0）由 Sidebar 组装行时注入（最后可见行收尾）。中间展开节点（hasChildren && !collapsed）的 tail 层改画贯穿线，避免中层断口。
- **缩进加深**：步长 12 → 18（`14 + depth*18`，depth 0 特判 26 容纳项目线）。
- **项目文件夹行强化**：常显浅灰底 `rgba(127,127,127,0.07)`（不再是透明/弱化）、路径 mono 12px **600 加粗** `var(--text)`（原来 11.5 muted 倒挂弱于会话行）、图标 16px `var(--text)`；hover 变 `--bg-hover`、选中保留 accent 左条。


### 5. i18n（en.ts / zh-CN.ts / zh-TW.ts）

- 新增 `sidebar.expandProject` / `sidebar.collapseProject`（项目行箭头 title）。
- 现有 `sidebar.expandSubagents` / `sidebar.collapseSubagents` 文案从「子智能体」改为「子会话」（现在包含 fork）：
  - en: "Expand child sessions" / "Collapse child sessions"
  - zh-CN: "展开子会话" / "折叠子会话"
  - zh-TW: "展開子會話" / "摺疊子會話"

### 6. 测试更新

- `lib/session-tree.test.mjs`：
  - 首用例「only subagents nest while forks remain independent roots」→ 改为「forks and subagents nest under their parent」（fork 变 child）。
  - 新增 `flattenSessionTree` 用例：先序顺序、折叠跳过子树、多级深度、孤儿。
- `components/SessionSidebar.test.mjs` L125「hides subagent rows and aggregates their state」→ 重写为断言树路径：`buildSessionTree`/`flattenSessionTree` 被使用、`listSessionFamilies`/`sessionFamilies` 不再出现、`collapsedProjectKeys`/`collapsedSessionIds` 存在。

## 不改的部分

- 虚拟滚动机制、`getSessionListIndices`、`SESSION_LIST_ITEM_HEIGHT` 全部保留。
- worktree 切换器 / SessionSearch / FileExplorer / 服务器端 `/api/sessions` / 类型 `SessionInfo` 不动。
- `lib/session-family.ts` 保留（其他地方可能引用，仅 SessionSidebar 不再 import）。

## 风险点

| 风险 | 缓解 |
|---|---|
| 项目/会话很多时默认全展开 → 行数和滚动位置变化 | 折叠状态仅前端 state（刷新重置）；保留虚拟滚动 |
| fork 树深（层级多）递归拍平爆栈 | 拍平用显式栈迭代 + 深层测试 |
| 选中项在折叠祖先下不可见 | 选中变化时自动展开项目文件夹 + 会话祖先链 |
| subagent/fork 图标混淆 | depth>0 时按 relation.kind 区分（机器人 vs 分支） |
| 移除下拉后「自定义路径/默认目录」入口消失 | 用户确认移除选择器；功能入口后续可按需加回 |
