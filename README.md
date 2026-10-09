# TripEZGo MCP

Let an AI on your computer plan and edit your trips in the **TripEZGo** iPhone app — all of them, not only the one
open on the phone.

The app itself is the MCP server: while its "連接電腦 AI" (connect computer AI) page is open, the iPhone serves
MCP over Streamable HTTP on your Wi-Fi at `http://IP:PORT/mcp`. Claude Code and Codex connect to that address
directly — **you don't need anything from this repo for them**.

This repo holds the few things the phone can't do:

- **A stdio bridge** for clients that only start local processes (Claude Desktop). It forwards every JSON-RPC
  message to the app unchanged and writes the answer back unchanged.
- **`add_attachment_from_path`**, a local tool the bridge adds to the app's tool list: it reads a file on this
  computer and uploads it to the app (up to 20 MB, the app's limit for one attachment; the app states it when the bridge connects).
- **A skill** (`skills/tripezgo/`) that plans a trip with web research and tells an agent how to use the tools
  well — also installable as a Claude Code plugin (see [Install the planning skill](#install-the-planning-skill)).

This repo owns no tool definitions — they all come from the app, so the two never fall out of step.

## On the phone

1. Put the iPhone and the computer on the **same Wi-Fi**.
2. Open TripEZGo and either
   - **Settings › 用電腦 AI 編輯** (edit with a computer AI; the trip open on the phone, if any, is the default), or
   - **New trip › 用電腦 AI 建立旅程** (let the AI create a new trip).

   Either way the AI can read and change **every** trip in the app. The default trip is only the one it uses
   when it doesn't say which trip.
3. The page shows the address and a ready-made command for Claude Code, Codex and Claude Desktop. Tap
   **複製命令** (copy command) and paste it on the computer.
4. Keep the page open. Locking the phone or switching apps pauses the link; coming back resumes it with the same
   command. Closing the page ends it.

Below, `IP:PORT` and `TOKEN` stand for the values the page shows.

## Claude Code

```sh
claude mcp add --transport http tripezgo http://IP:PORT/mcp --header "Authorization: Bearer TOKEN"
```

## Codex

Codex reads MCP servers from `~/.codex/config.toml`. Add (or replace) this table:

```toml
[mcp_servers.tripezgo]
url = "http://IP:PORT/mcp"
http_headers = { "Authorization" = "Bearer TOKEN" }
```

Or keep the token in an environment variable and add the server from the command line
(`codex mcp add` has no header flag; `--bearer-token-env-var` names the variable whose value is sent as
`Authorization: Bearer …`):

```sh
export TRIPEZGO_TOKEN=TOKEN
codex mcp add tripezgo --url http://IP:PORT/mcp --bearer-token-env-var TRIPEZGO_TOKEN
```

The variable must be set in the shell that starts Codex. See the
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Desktop

Claude Desktop only launches local stdio servers, so it goes through this repo's bridge. Edit
`claude_desktop_config.json` (Claude › Settings › Developer › Edit Config):

```json
{
  "mcpServers": {
    "tripezgo": {
      "command": "npx",
      "args": ["-y", "github:TripEZGo/mcp", "--url", "http://IP:PORT", "--token=TOKEN"]
    }
  }
}
```

Restart Claude Desktop after saving. Requires Node.js 18 or later (`npx` comes with it).

The bridge also reads `TRIPEZGO_URL` and `TRIPEZGO_TOKEN` from the environment (flags win). `--url` accepts
`IP:PORT`, `http://IP:PORT`, or the `http://IP:PORT/mcp` address shown for direct clients.

The bridge's tool list is the app's plus `add_attachment_from_path`, so Claude Code or Codex can use it too
when you want to attach local files: point them at the bridge as a stdio server instead of the HTTP address.

## Security

- The token is random, made fresh each time the page opens, and **only valid while that page stays open**.
  Close the page and the token is dead; the next time you open it you get a new command.
- Without the token, nobody else on the same Wi-Fi (café, hotel) can talk to the app.
- The AI can do no more than you can in the app: read-only and shared-trip limits and your trip limit still
  apply. Its changes are not confirmed one by one on the phone; the page lists them as they happen.
- Traffic stays on your local network and is plain HTTP — use a network you trust.

## How the bridge talks to the app

- `POST <url>/mcp` with the stdin line as the body, `Content-Type: application/json`,
  `Accept: application/json, text/event-stream`, `Authorization: Bearer <token>`. After `initialize`, the
  `Mcp-Session-Id` (if the app sends one) and `MCP-Protocol-Version` headers are sent on every request.
  A `202` (notification accepted) writes nothing back.
- `add_attachment_from_path` → `POST <url>/upload?tripId=&eventId=&name=` with the file's raw bytes,
  `Content-Type` from the file extension, `Authorization: Bearer <token>` and `X-TripEZGo-Api-Level: 1`.
  Omitted ids are left out of the query.
- **API level.** The app reports its level in the `initialize` result as `_meta: {"tripezgo/apiLevel": 1}`.
  The bridge checks nothing up front: only the upload endpoint depends on it, and the app answers `409` when
  the levels differ. The tool then tells you to update the app or this bridge.

## Install the planning skill

`skills/tripezgo` teaches the AI to plan a trip the way this app expects: ask the seven things a plan needs,
pin the destination's time zone with the app, read the TripEZGo author's first-hand travel journals and recent
travel articles, check that every place is still open on the day it is scheduled, keep each day to a sane
pace, show a day-by-day draft, and write it into the app only after you approve it. It also carries the
rules for every other read and edit. **Planning needs an AI with web search turned on**; without it the skill
declines to plan.

### Claude Code

As a plugin (this repo is its own marketplace), in Claude Code 2.1.275 or later:

```
/plugin install tripezgo --marketplace TripEZGo/mcp
```

On older versions, add the marketplace first, then install:

```
/plugin marketplace add TripEZGo/mcp
/plugin install tripezgo@tripezgo
```

From a terminal instead (this is the line the app's link page copies; both steps are safe to re-run):

```sh
claude plugin marketplace add TripEZGo/mcp && claude plugin install tripezgo@tripezgo
```

The skill then shows up as `tripezgo:tripezgo`. Or skip the plugin and copy the folder yourself:

```sh
git clone https://github.com/TripEZGo/mcp.git
cp -R mcp/skills/tripezgo ~/.claude/skills/
```

### Claude Desktop (and claude.ai)

Custom skills are uploaded as a ZIP of the skill folder. Turn on **Settings › Capabilities › Code execution and
file creation** first, then:

```sh
git clone https://github.com/TripEZGo/mcp.git
cd mcp/skills && zip -r tripezgo.zip tripezgo
```

In Claude, go to **Customize › Skills**, click **+**, then **+ Create skill › Upload a skill**, and pick
`tripezgo.zip`. Uploaded skills are private to your account.
See [Using Skills in Claude](https://support.claude.com/en/articles/12512180-using-skills-in-claude).

### Codex

Codex reads skills in the same `SKILL.md` format from `$HOME/.agents/skills` (every repository) or
`.agents/skills` in a repository:

```sh
d=$(mktemp -d) && git clone --depth 1 https://github.com/TripEZGo/mcp.git "$d" && mkdir -p ~/.agents/skills && cp -R "$d/skills/tripezgo" ~/.agents/skills/
```

(This is the line the app's link page copies; it clones into a temporary folder, so re-running it to update is safe.)

See [Codex: Build skills](https://learn.chatgpt.com/docs/build-skills). If your Codex has no skills support, point
`AGENTS.md` at the file instead — add a line such as
`When planning a trip or using the tripezgo MCP server, read ~/.agents/skills/tripezgo/SKILL.md first and follow it.`
— or paste `SKILL.md` into the conversation; it tells the AI which file under `references/` to read next.

## Development

```sh
npm install
npm test        # builds dist/, then runs vitest
npm run build
```

`dist/` is **committed on purpose**. `npx github:TripEZGo/mcp` installs straight from this repository; with
the compiled JavaScript checked in there is no `prepare` step, so the user's machine never needs TypeScript or
a build to succeed. Rebuild and commit `dist/` with every source change (`npm test` rebuilds it).

---

## 繁體中文

這個 repo 是 TripEZGo iPhone App「連接電腦 AI」功能的電腦端配套。App 本身就是 MCP server（同一個 Wi-Fi 上的
`http://IP:PORT/mcp`），Claude Code 與 Codex 直接連，不需要這個 repo。這裡只放手機做不到的事：給只吃 stdio 的
Claude Desktop 用的轉接器、讀電腦本機檔案上傳成附件的 `add_attachment_from_path`，以及旅行規劃 skill（Claude Code 可用
`/plugin install tripezgo --marketplace TripEZGo/mcp` 一行安裝；Claude Desktop 與 Codex 的裝法見上方 Install the planning skill）。

AI 能讀寫 App 裡**所有**旅程，不只手機上開著的那一趟；從設定進來時，開著的那一趟只是 AI 沒指明哪一趟時的預設。

手機端：**設定 › 用電腦 AI 編輯**，或**新增旅程 › 用電腦 AI 建立旅程**，打開「連接電腦 AI」頁，按「複製命令」貼到
電腦上。手機和電腦要在同一個 Wi-Fi。頁面要一直開著：鎖屏或切到別的 App 會暫停，回來自動接上；關掉頁面就中斷，
那組憑證同時作廢，下次打開會是新的命令。

## License

MIT © TripEZGo
