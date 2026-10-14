import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type InstallConfig, readInstallConfig, replaceDir, writeFileAtomic } from "./fsutil.js";

export const CLIENTS = ["claude-code", "codex", "claude-desktop"] as const;
export type Client = (typeof CLIENTS)[number];

export const INSTALL_USAGE = "Usage: npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command itself doesn't exist on PATH. */
  notFound?: boolean;
}

export interface InstallDeps {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Absolute path of the node binary that runs the launcher. GUI apps don't get nvm's PATH, so no bare `node`. */
  nodePath: string;
  /** The package being installed: holds dist/, skills/, snapshot/ and package.json. */
  packageRoot: string;
  version: string;
  run: (command: string, args: string[]) => Promise<RunResult>;
  out: (line: string) => void;
}

/** `install <client>`. Returns the exit code. Safe to run again: every step replaces what it wrote before. */
export async function runInstall(args: readonly string[], deps: InstallDeps): Promise<number> {
  const client = args[0] as Client | undefined;
  if (args.length !== 1 || !client || !CLIENTS.includes(client)) {
    deps.out(INSTALL_USAGE);
    return 2;
  }

  const home = join(deps.home, ".tripezgo");
  const launcher = join(home, "launcher.mjs");
  const tag = `v${deps.version}`;
  const summary: string[] = [];

  try {
    await mkdir(home, { recursive: true });
    await writeFileAtomic(launcher, await readFile(join(deps.packageRoot, "dist", "launcher.mjs")));
    summary.push(`Launcher: ${launcher}`);
    summary.push(`Cached ${tag}: ${(await seedVersion(home, tag, deps.packageRoot)) ? "added" : "already there"}`);

    let skillDir: string | undefined;
    switch (client) {
      case "claude-code": {
        const result = await installClaudeCode(deps, launcher, summary);
        if (result !== 0) return finish(deps, client, summary, result);
        skillDir = join(deps.home, ".claude", "skills", "tripezgo");
        break;
      }
      case "codex": {
        const path = join(deps.env.CODEX_HOME || join(deps.home, ".codex"), "config.toml");
        let toml = "";
        try {
          toml = await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await writeFileAtomic(path, upsertCodexServer(toml, deps.nodePath, [launcher]));
        summary.push(`Codex MCP server "tripezgo": ${path}`);
        skillDir = join(deps.home, ".agents", "skills", "tripezgo");
        break;
      }
      case "claude-desktop": {
        const result = await installClaudeDesktop(deps, launcher, summary);
        if (result !== 0) return finish(deps, client, summary, result);
        break;
      }
    }

    if (skillDir) {
      await replaceDir(join(deps.packageRoot, "skills", "tripezgo"), skillDir, tag);
      summary.push(`Planning skill: ${skillDir}`);
    } else {
      summary.push("Planning guide: served by the MCP server itself (get_planning_guide)");
    }

    const configPath = join(home, "config.json");
    const config: InstallConfig = await readInstallConfig(configPath);
    config.clients[client] = { ...(skillDir ? { skillDir } : {}), installedAt: new Date().toISOString() };
    await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    summary.push(`Failed: ${(error as Error).message}`);
    return finish(deps, client, summary, 1);
  }

  return finish(deps, client, summary, 0);
}

const CLIENT_NAMES: Record<Client, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
};

function finish(deps: InstallDeps, client: Client, summary: string[], code: number): number {
  deps.out(code === 0 ? `TripEZGo is installed for ${CLIENT_NAMES[client]}.` : `TripEZGo was NOT installed for ${CLIENT_NAMES[client]}.`);
  for (const line of summary) deps.out(`  ${line}`);
  if (code === 0) {
    deps.out("");
    if (client === "claude-desktop") {
      deps.out("Fully quit Claude Desktop (Quit from the menu, not just closing the window) and open it again.");
    } else {
      deps.out(`Start a new ${CLIENT_NAMES[client]} session to pick it up.`);
    }
    deps.out(
      'To connect: on the iPhone open TripEZGo › Settings › 用電腦 AI 編輯 ("Connect computer AI") and paste the ' +
        "sentence it shows (連接 TripEZGo：…，金鑰 …) into the conversation.",
    );
    deps.out("Updates install themselves each time the AI app starts the server. Re-running this command is harmless.");
  }
  return code;
}

/** Copies the package being installed into `versions/<tag>` so the first start works offline. */
async function seedVersion(home: string, tag: string, packageRoot: string): Promise<boolean> {
  const versions = join(home, "versions");
  const target = join(versions, tag);
  if (existsSync(join(target, "dist", "cli.js"))) return false;
  await mkdir(versions, { recursive: true });
  const temp = join(home, "tmp", `seed-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(temp, { recursive: true });
    for (const entry of ["dist", "skills", "snapshot", "package.json"]) {
      const from = join(packageRoot, entry);
      if (existsSync(from)) await cp(from, join(temp, entry), { recursive: true });
    }
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return true;
}

async function installClaudeCode(deps: InstallDeps, launcher: string, summary: string[]): Promise<number> {
  const claude = (...args: string[]) => deps.run("claude", args);

  const version = await claude("--version");
  if (version.notFound) {
    summary.push("The `claude` command isn't on PATH. Install Claude Code first (https://claude.com/claude-code), then run this again.");
    return 1;
  }

  // The 0.1 skill came as a plugin from this repo's marketplace; the installer replaces it.
  const plugins = parseJsonArray((await claude("plugin", "list", "--json")).stdout);
  for (const plugin of plugins) {
    if (plugin.id !== "tripezgo@tripezgo") continue;
    const scope = typeof plugin.scope === "string" ? plugin.scope : "user";
    const result = await claude("plugin", "uninstall", "tripezgo@tripezgo", "-s", scope);
    summary.push(
      result.code === 0
        ? `Removed the old tripezgo plugin (${scope} scope)`
        : `Couldn't remove the old tripezgo plugin (${scope} scope): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const marketplaces = parseJsonArray((await claude("plugin", "marketplace", "list", "--json")).stdout);
  if (marketplaces.some((m) => m.name === "tripezgo")) {
    const result = await claude("plugin", "marketplace", "remove", "tripezgo");
    summary.push(
      result.code === 0
        ? "Removed the old tripezgo marketplace"
        : `Couldn't remove the old tripezgo marketplace: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  // `add` refuses an existing name; remove first so re-running replaces it. A missing entry is fine.
  await claude("mcp", "remove", "-s", "user", "tripezgo");
  const add = await claude("mcp", "add", "-s", "user", "tripezgo", "--", deps.nodePath, launcher);
  if (add.code !== 0) {
    summary.push(`claude mcp add failed: ${(add.stderr || add.stdout).trim() || `exit ${add.code}`}`);
    return 1;
  }
  summary.push(`Claude Code MCP server "tripezgo" (user scope): ${deps.nodePath} ${launcher}`);
  summary.push(
    "If you once added tripezgo inside a project with the old `claude mcp add --transport http` command, " +
      "run `claude mcp remove tripezgo -s local` in that project so it doesn't hide this one.",
  );
  return 0;
}

async function installClaudeDesktop(deps: InstallDeps, launcher: string, summary: string[]): Promise<number> {
  const path = claudeDesktopConfigPath(deps);
  if (!path) {
    summary.push("Can't find Claude Desktop's settings folder (%APPDATA% is not set).");
    return 1;
  }
  let config: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined && text.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      summary.push(`${path} isn't valid JSON, so it was left alone. Fix or remove it, then run this again.`);
      return 1;
    }
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  servers.tripezgo = { command: deps.nodePath, args: [launcher] };
  config.mcpServers = servers;
  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  summary.push(`Claude Desktop MCP server "tripezgo": ${path}`);
  return 0;
}

function claudeDesktopConfigPath(deps: InstallDeps): string | undefined {
  const file = "claude_desktop_config.json";
  if (deps.platform === "darwin") return join(deps.home, "Library", "Application Support", "Claude", file);
  if (deps.platform === "win32") return deps.env.APPDATA ? join(deps.env.APPDATA, "Claude", file) : undefined;
  return join(deps.env.XDG_CONFIG_HOME || join(deps.home, ".config"), "Claude", file);
}

/**
 * Puts `[mcp_servers.tripezgo]` (command, args) into a Codex config.toml: an existing tripezgo table and its
 * sub-tables are dropped, every other line is kept as it was.
 */
export function upsertCodexServer(toml: string, command: string, args: string[]): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const name = header[1]
        .split(".")
        .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
        .join(".");
      skipping = name === "mcp_servers.tripezgo" || name.startsWith("mcp_servers.tripezgo.");
    }
    if (!skipping) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const table = [
    "[mcp_servers.tripezgo]",
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    // A start may download an update before the bridge answers.
    "startup_timeout_sec = 30",
  ];
  return [...kept, ...(kept.length > 0 ? [""] : []), ...table, ""].join("\n");
}

/** A TOML basic string. JSON's escaping is a subset of TOML's for everything a path can hold. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parseJsonArray(text: string): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
  } catch {
    return [];
  }
}

/** The real `run`: no shell, output collected, ENOENT reported as `notFound`. */
export function runCommand(command: string, args: string[]): Promise<RunResult> {
  // On Windows `claude` is often claude.cmd, which Node only starts through the shell; quote every argument.
  const windows = process.platform === "win32";
  return new Promise((resolve) => {
    const child = windows
      ? spawn(command, args.map((arg) => `"${arg}"`), { stdio: ["ignore", "pipe", "pipe"], shell: true })
      : spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: -1, stdout, stderr: error.message, notFound: error.code === "ENOENT" }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr, notFound: windows && (code === 9009 || /is not recognized/.test(stderr)) }),
    );
  });
}
