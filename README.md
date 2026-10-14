# TripEZGo MCP

Let an AI on your computer plan and edit your trips in the **TripEZGo** iPhone app — all of them, not only the one
open on the phone.

Install once. Nothing about your phone goes into any configuration: to connect, you paste one sentence from the
iPhone into the conversation. The server and the planning skill update themselves.

## Install

Requires [Node.js](https://nodejs.org) 18 or later. Run the line for your AI app in a terminal:

| AI app | Install |
|---|---|
| Claude Code | `npx -y github:TripEZGo/mcp install claude-code` |
| Codex | `npx -y github:TripEZGo/mcp install codex` |
| Claude Desktop | `npx -y github:TripEZGo/mcp install claude-desktop` |

Then start a new Claude Code / Codex session, or **fully quit Claude Desktop and open it again**. Running the
line again is harmless; installing for a second app keeps the first.

What it does:

- Puts a small launcher at `~/.tripezgo/launcher.mjs` and registers it as the `tripezgo` MCP server, run with
  the absolute path of your `node` (apps opened from the Dock don't see a shell `PATH`). No arguments, no
  address, no token.
  - Claude Code: `claude mcp add -s user tripezgo -- <node> ~/.tripezgo/launcher.mjs`. An earlier
    `tripezgo` plugin and its marketplace (0.1) are removed.
  - Codex: a `[mcp_servers.tripezgo]` table in `~/.codex/config.toml` (or `$CODEX_HOME`); the rest of the file
    is kept.
  - Claude Desktop: a `tripezgo` entry in `claude_desktop_config.json` (macOS `~/Library/Application
    Support/Claude/`, Windows `%APPDATA%\Claude\`); other servers are kept.
- Copies the planning skill to `~/.claude/skills/tripezgo` (Claude Code) or `~/.agents/skills/tripezgo`
  (Codex). Claude Desktop gets the same guide from the server's `get_planning_guide` tool.

If you re-install Node.js somewhere else (a different nvm version, say), run the install line again.

## Connect

1. Put the iPhone and the computer on the **same Wi-Fi**.
2. In TripEZGo open **Settings › 用電腦 AI 編輯** (or **New trip › 用電腦 AI 建立旅程**). The "Connect computer
   AI" page shows a sentence like

   ```
   連接 TripEZGo：192.168.1.23:8765，金鑰 abc123…
   ```

   or, in the phone's language, `连接 TripEZGo：…，密钥 …` / `Connect to TripEZGo: …, key …` /
   `TripEZGo に接続：…、キー …` / `TripEZGo 연결: …, 키 …`.

3. Copy it and paste it into the conversation. The AI calls the `connect` tool with it and is connected.
4. Keep the page open. Locking the phone or switching apps pauses the link and coming back resumes it. Closing
   the page ends it; next time, paste the new sentence.

If you ask for something in TripEZGo before connecting, the AI asks you for the sentence.

The AI can read and change **every** trip in the app. Opened from Settings, the trip open on the phone is the
default — the one used when the AI doesn't say which trip; opened from New trip there is no default.

## Updates

Every time your AI app starts the server, the launcher runs the newest version already on the computer
(`~/.tripezgo/versions/<tag>`) at once — startup never waits on the network — and refreshes the installed skill
folders from that version. Meanwhile a background process checks this repository's newest release tag
(`vX.Y.Z`, 2-second timeout) and, if it is newer, downloads it; it runs from the **next** start. Offline or slow
GitHub changes nothing. The two newest versions are kept; the background log is `~/.tripezgo/update.log`. Set
`TRIPEZGO_NO_UPDATE=1` in the server's environment to skip the check.

## Tools

Before connecting, the server lists the app's tools from a snapshot built into each release
(`snapshot/app-tools.json`), so clients that read the tool list only once still see them. Calling one before
connecting answers with how to connect. Added by the server itself:

| Tool | |
|---|---|
| `connect` | `address` (`IP:PORT`, `http://IP:PORT` or `…/mcp`) and `token` from the sentence. Calling it again replaces the connection. |
| `get_planning_guide` | The planning skill: everything, or one `topic`. Works without a connection. |
| `add_attachment_from_path` | Reads a file on this computer and attaches it to a trip or event (up to the app's limit, 20 MB). |

If the iPhone runs an older TripEZGo that lacks a tool, the tool answers that the app needs an update from the
App Store.

## Security

- The key is random, made fresh each time the page opens, and **only valid while that page stays open**.
- Without the key, nobody else on the same Wi-Fi (café, hotel) can talk to the app.
- The AI can do no more than you can in the app: read-only and shared-trip limits and your trip limit still
  apply. Its changes are not confirmed one by one on the phone; the page lists them as they happen.
- Traffic stays on your local network and is plain HTTP — use a network you trust.
- The key appears in the conversation; it dies with the page.

## Older app versions

TripEZGo builds from before this change copy a command with the address and token in it. That still works:

```sh
npx -y github:TripEZGo/mcp --url http://IP:PORT --token=TOKEN
```

With `--url` / `--token` (or `TRIPEZGO_URL` / `TRIPEZGO_TOKEN`) the bridge forwards every JSON-RPC line to
that address unchanged and adds `add_attachment_from_path`, as in 0.1.

## How the bridge talks to the app

- `connect` posts `initialize` to `POST <address>/mcp` with `Authorization: Bearer <token>`, passing on the
  `clientInfo` your AI app sent (the phone's activity log shows "Claude Code", …), then
  `notifications/initialized`. The app's `Mcp-Session-Id` and protocol version go on every later request.
- App tool calls are forwarded byte for byte; the app's answers come back unchanged, except that
  `Unknown tool: X` becomes "update the app", and a `401` becomes "paste the sentence again".
- `add_attachment_from_path` → `POST <address>/upload?tripId=&eventId=&name=` with the raw bytes,
  `Content-Type` from the file extension, the token, and `X-TripEZGo-Api-Level: 1`. The app answers `409` when
  the levels differ; the tool then says to update.

## Development

```sh
npm install
npm test          # typecheck, build the bundles, vitest
npm run build     # dist/cli.js and dist/launcher.mjs (esbuild)
node scripts/sync-app-tools.mjs <app-tools-list.json>   # refresh snapshot/app-tools.json
```

`dist/` is **committed on purpose**: a release tag's tarball must run with no `npm install`, so both files are
single, dependency-free bundles. Rebuild and commit `dist/` with every source change (`npm test` rebuilds it).

`snapshot/app-tools.json` is the app's `tools/list` result (`{"tools":[…]}`) for the newest app release; update
it whenever the app's tools change, before tagging.

Releasing: bump `version` in `package.json`, `npm test`, commit, tag `vX.Y.Z` and push the tag. Installed
launchers pick it up on their next start.

---

## 繁體中文

這個 repo 是 TripEZGo iPhone App「連接電腦 AI」功能的電腦端：裝一次就好，之後自動更新，設定裡不放 IP、port、金鑰。

**安裝**（需要 Node.js 18 以上），在終端機跑你用的那一個：

```sh
npx -y github:TripEZGo/mcp install claude-code
npx -y github:TripEZGo/mcp install codex
npx -y github:TripEZGo/mcp install claude-desktop
```

裝完開新的 Claude Code／Codex 對話；Claude Desktop 要完全結束再重開。重跑無害。

**連線**：手機和電腦連同一個 Wi-Fi，在 TripEZGo 開**設定 › 用電腦 AI 編輯**（或**新增旅程 › 用電腦 AI 建立旅程**），
把頁面上那句「連接 TripEZGo：IP:PORT，金鑰 …」複製貼到對話裡，AI 會自己連上。頁面要一直開著：鎖屏或切到別的 App
會暫停，回來自動接上；關掉頁面就中斷、金鑰作廢，下次貼新的那句。AI 能讀寫 App 裡**所有**旅程。

**更新**：每次 AI App 啟動這個 server，啟動器立刻執行電腦上已有的最新版（不等網路），同時在背景查這個 repo
最新的版本標籤，有新版就下載，下一次啟動生效；已安裝的 skill 跟著執行中的版本更新。離線不影響。

## License

MIT © TripEZGo
