# Pi Web

[中文文档](./README.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Usage analytics**: track per-provider spending, balances, and cache hit rates. Set a balance per provider; all of its models share the balance and deduct from it. Message rows show the real cost and remaining provider balance.
- **Per-provider HTTP proxy**: give a blocked provider its own proxy (e.g. `http://127.0.0.1:7890`) from the Models panel; only that provider's traffic goes through it, while others connect directly.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Release Notes

Local mainline based on official v0.9.1 (forked from agegr/pi-web). Features added or enhanced beyond the official release:

### Sidebar & Sessions
- **Session file tree**: sidebar sessions shown as a project folder tree, with collapse state persisted across reloads (`36533e5`, `93e0fa1`)
- **Browser-style session tabs**: switch between sessions like browser tabs in the top bar (`a9a6fba`)
- **Three-segment top bar layout**: restructured into three sections; panels collapse on outside click or Esc; system prompt composition panel collapsed by default (`12de342`, `0a5c22f`, `96bcd1c`, `a687c36`)

### Usage & Balances
- **Usage stats panel**: cache hit rate cards, per-provider balance tracking, compact used/total context usage display (`1dd312e`, `814599e`, `b220298`, `83a863f`, `492e3f7`)
- **Per-message balance snapshots**: each assistant message shows its balance snapshot, real cost, and cache hit rate (4 decimals) at completion time; balances refetched after each run (`173216e`, `dabc868`, `a12818f`, `cd6b6b5`)

### Files & File Tree
- **File browser moved into the right panel** as a pinned tab; explorer actions merged into the file browser toolbar; Windows CRLF and node-pty test compatibility and style hydration mismatch fixes (`10db5f8`, `bba4616`, `3435e21`, `f475369`)
- **Inline file editing in the file viewer**: edit and save files directly in the viewer; per-message cache hit rate (`45bd97f`)
- Dropped/picked files resolved to absolute paths (`80e6dd5`)

### Message Display
- Provider and per-message thinking level shown in the assistant message header; think-tagged reasoning split into thinking blocks (`1b8296c`, `f825f66`, `a426d90`)
- **Hierarchical system prompt composition**: per-plugin attribution with token estimates (`801d625`, `09c3056`)

### Proxy & Configuration
- **Per-provider HTTP proxy routing**: configure a separate proxy for a blocked provider (`a506306`)

### Stability & UX
- Composer drafts persisted across sessions + context gauge (`79096a7`)
- Web theme system, UX polish, and accurate tool timing; merged upstream v0.9.0 (`33952d2`, `3e2c3f3`, `6b720de`)

### Docs & Tooling
- Bilingual README (Simplified Chinese default); split AGENTS.md rules from reference docs (`b04bcfa`, `cae5156`)
- Cache hit-rate analysis scripts (`scripts/`, `e977cc5`, `70043a0`, `185525b`)

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @agegr/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

To update, stop the running process with `Ctrl+C` and run the same install command again. To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable HTTP Basic Auth; the username is always `pi` | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Basic Auth does not encrypt the password in transit. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.
See [AGENTS.md](./AGENTS.md) for the development rules loaded at startup. Detailed material is split out and loaded on demand:
- [Architecture & design decisions](./docs/ARCHITECTURE.md) — component overview, key traps (AgentSession lifecycle, fork, branching, worktrees, file access), dev server troubleshooting
- [Session file format & CSS variables](./docs/SESSION-FORMAT.md) — `.jsonl` schema and theming tokens
- [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md) for contributors
## License

[MIT](./LICENSE)
