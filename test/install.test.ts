import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallDeps, type RunResult, runInstall, upsertCodexServer } from "../src/install.js";

const NODE = "/opt/node/bin/node";

interface Fixture {
  root: string;
  home: string;
  pkg: string;
  calls: string[][];
  out: string[];
  deps: InstallDeps;
  /** What each `claude …` command answers, keyed by its arguments joined with spaces. */
  answers: Map<string, RunResult>;
}

async function fixture(platform: NodeJS.Platform = "darwin", env: Record<string, string> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tripezgo-install-"));
  const home = join(root, "home");
  const pkg = join(root, "pkg");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(join(pkg, "skills", "tripezgo", "references"), { recursive: true });
  await mkdir(join(pkg, "snapshot"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"tripezgo-mcp","version":"0.2.0"}');
  await writeFile(join(pkg, "dist", "cli.js"), "// cli");
  await writeFile(join(pkg, "dist", "launcher.mjs"), "// launcher");
  await writeFile(join(pkg, "skills", "tripezgo", "SKILL.md"), "skill v0.2.0");
  await writeFile(join(pkg, "skills", "tripezgo", "references", "planning.md"), "planning");
  await writeFile(join(pkg, "snapshot", "app-tools.json"), '{"tools":[]}');
  const calls: string[][] = [];
  const out: string[] = [];
  const answers = new Map<string, RunResult>();
  const deps: InstallDeps = {
    home,
    platform,
    env,
    nodePath: NODE,
    packageRoot: pkg,
    version: "0.2.0",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return answers.get(args.join(" ")) ?? { code: 0, stdout: "", stderr: "" };
    },
    out: (line) => out.push(line),
  };
  return { root, home, pkg, calls, out, deps, answers };
}

describe("install, common to every client", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("copies the launcher, seeds the version cache and records the client", async () => {
    expect(await runInstall(["codex"], f.deps)).toBe(0);

    expect(await readFile(join(f.home, ".tripezgo", "launcher.mjs"), "utf8")).toBe("// launcher");
    const seeded = join(f.home, ".tripezgo", "versions", "v0.2.0");
    expect(await readFile(join(seeded, "dist", "cli.js"), "utf8")).toBe("// cli");
    expect(await readFile(join(seeded, "skills", "tripezgo", "SKILL.md"), "utf8")).toBe("skill v0.2.0");
    expect(existsSync(join(seeded, "snapshot", "app-tools.json"))).toBe(true);
    expect(existsSync(join(seeded, "package.json"))).toBe(true);
    const config = JSON.parse(await readFile(join(f.home, ".tripezgo", "config.json"), "utf8"));
    expect(config.clients.codex.skillDir).toBe(join(f.home, ".agents", "skills", "tripezgo"));
  });

  it("leaves an already cached version alone", async () => {
    const seeded = join(f.home, ".tripezgo", "versions", "v0.2.0", "dist");
    await mkdir(seeded, { recursive: true });
    await writeFile(join(seeded, "cli.js"), "// downloaded earlier");

    await runInstall(["codex"], f.deps);

    expect(await readFile(join(seeded, "cli.js"), "utf8")).toBe("// downloaded earlier");
  });

  it("keeps the other clients in config.json when a second one is installed", async () => {
    await runInstall(["codex"], f.deps);
    await runInstall(["claude-desktop"], f.deps);

    const config = JSON.parse(await readFile(join(f.home, ".tripezgo", "config.json"), "utf8"));
    expect(Object.keys(config.clients).sort()).toEqual(["claude-desktop", "codex"]);
  });

  it("refuses an unknown or missing client with the usage and changes nothing", async () => {
    expect(await runInstall(["vscode"], f.deps)).toBe(2);
    expect(await runInstall([], f.deps)).toBe(2);
    expect(f.out.join("\n")).toMatch(/claude-code\|codex\|claude-desktop/);
    expect(existsSync(join(f.home, ".tripezgo"))).toBe(false);
  });
});

describe("install claude-code", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("re-adds the user-scope tripezgo server as absolute node + launcher, and copies the skill", async () => {
    expect(await runInstall(["claude-code"], f.deps)).toBe(0);

    const launcher = join(f.home, ".tripezgo", "launcher.mjs");
    const removeAt = f.calls.findIndex((c) => c.join(" ") === "claude mcp remove -s user tripezgo");
    const addAt = f.calls.findIndex((c) => c.join(" ") === `claude mcp add -s user tripezgo -- ${NODE} ${launcher}`);
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThan(removeAt);
    const skill = join(f.home, ".claude", "skills", "tripezgo");
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("skill v0.2.0");
    expect(await readFile(join(skill, ".tripezgo-version"), "utf8")).toBe("v0.2.0\n");
    expect(f.out.join("\n")).toMatch(/Claude Code/);
  });

  it("removes the old tripezgo plugin and marketplace when they are installed", async () => {
    f.answers.set("plugin list --json", {
      code: 0,
      stdout: JSON.stringify([
        { id: "tripezgo@tripezgo", scope: "user" },
        { id: "figma@claude-plugins-official", scope: "user" },
      ]),
      stderr: "",
    });
    f.answers.set("plugin marketplace list --json", {
      code: 0,
      stdout: JSON.stringify([{ name: "tripezgo", repo: "TripEZGo/mcp" }, { name: "claude-hud" }]),
      stderr: "",
    });

    await runInstall(["claude-code"], f.deps);

    const lines = f.calls.map((c) => c.join(" "));
    expect(lines).toContain("claude plugin uninstall tripezgo@tripezgo -s user");
    expect(lines).toContain("claude plugin marketplace remove tripezgo");
    expect(lines.indexOf("claude plugin uninstall tripezgo@tripezgo -s user")).toBeLessThan(
      lines.indexOf("claude plugin marketplace remove tripezgo"),
    );
    expect(f.out.join("\n")).toMatch(/old tripezgo plugin/);
  });

  it("does not touch plugins when the old one isn't there", async () => {
    f.answers.set("plugin list --json", { code: 0, stdout: "[]", stderr: "" });
    f.answers.set("plugin marketplace list --json", { code: 0, stdout: "[]", stderr: "" });

    await runInstall(["claude-code"], f.deps);

    expect(f.calls.some((c) => c.includes("uninstall") || c.includes("remove") && c.includes("marketplace"))).toBe(false);
  });

  it("says Claude Code is missing when the claude command isn't found, and fails", async () => {
    f.deps.run = async (command, args) => {
      f.calls.push([command, ...args]);
      return { code: -1, stdout: "", stderr: "", notFound: true };
    };

    expect(await runInstall(["claude-code"], f.deps)).toBe(1);
    expect(f.out.join("\n")).toMatch(/`claude` command/);
  });

  it("fails with the CLI's own message when claude mcp add fails", async () => {
    f.answers.set(`mcp add -s user tripezgo -- ${NODE} ${join(f.home, ".tripezgo", "launcher.mjs")}`, {
      code: 1,
      stdout: "",
      stderr: "boom",
    });

    expect(await runInstall(["claude-code"], f.deps)).toBe(1);
    expect(f.out.join("\n")).toMatch(/boom/);
  });

  it("is harmless to run twice", async () => {
    await runInstall(["claude-code"], f.deps);
    expect(await runInstall(["claude-code"], f.deps)).toBe(0);
    expect(await readFile(join(f.home, ".claude", "skills", "tripezgo", "SKILL.md"), "utf8")).toBe("skill v0.2.0");
  });
});

describe("install codex", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("writes the tripezgo table into ~/.codex/config.toml, replacing an old one and keeping the rest", async () => {
    const path = join(f.home, ".codex", "config.toml");
    await mkdir(join(f.home, ".codex"), { recursive: true });
    await writeFile(
      path,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.tripezgo]",
        'url = "http://192.168.1.5:8765/mcp"',
        'http_headers = { "Authorization" = "Bearer old" }',
        "",
        "[mcp_servers.tripezgo.env]",
        'A = "1"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n"),
    );

    expect(await runInstall(["codex"], f.deps)).toBe(0);

    const toml = await readFile(path, "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(toml).not.toContain("Bearer old");
    expect(toml).not.toContain("[mcp_servers.tripezgo.env]");
    expect(toml.match(/\[mcp_servers\.tripezgo\]/g)).toHaveLength(1);
    expect(toml).toContain(`command = ${JSON.stringify(NODE)}`);
    expect(toml).toContain(`args = [${JSON.stringify(join(f.home, ".tripezgo", "launcher.mjs"))}]`);
    expect(f.calls).toEqual([]);
    expect(await readFile(join(f.home, ".agents", "skills", "tripezgo", "SKILL.md"), "utf8")).toBe("skill v0.2.0");
  });

  it("creates config.toml when there is none, and honours CODEX_HOME", async () => {
    const codexHome = join(f.root, "codex-home");
    f.deps.env = { CODEX_HOME: codexHome };

    await runInstall(["codex"], f.deps);

    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toMatch(/^\[mcp_servers\.tripezgo\]/);
  });
});

describe("upsertCodexServer", () => {
  it("is stable when run on its own output", () => {
    const once = upsertCodexServer('a = 1\n\n[x]\ny = 2\n', "/n", ["/l"]);
    expect(upsertCodexServer(once, "/n", ["/l"])).toBe(once);
  });

  it("recognises a quoted table name and leaves look-alike names alone", () => {
    const toml = '[mcp_servers."tripezgo"]\ncommand = "old"\n\n[mcp_servers.tripezgo2]\ncommand = "keep"\n';
    const out = upsertCodexServer(toml, "/n", ["/l"]);
    expect(out).not.toContain('"old"');
    expect(out).toContain('[mcp_servers.tripezgo2]\ncommand = "keep"');
  });

  it("escapes Windows paths as TOML strings", () => {
    const out = upsertCodexServer("", "C:\\Program Files\\nodejs\\node.exe", ["C:\\Users\\a\\.tripezgo\\launcher.mjs"]);
    expect(out).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });
});

describe("install claude-desktop", () => {
  let f: Fixture;
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true });
  });

  it("adds tripezgo to claude_desktop_config.json on macOS, keeping other servers and settings", async () => {
    f = await fixture("darwin");
    const dir = join(f.home, "Library", "Application Support", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" }, tripezgo: { command: "npx", args: ["old"] } }, theme: "dark" }),
    );

    expect(await runInstall(["claude-desktop"], f.deps)).toBe(0);

    const config = JSON.parse(await readFile(join(dir, "claude_desktop_config.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.tripezgo).toEqual({ command: NODE, args: [join(f.home, ".tripezgo", "launcher.mjs")] });
    expect(f.out.join("\n")).toMatch(/quit Claude Desktop/i);
    expect(f.calls).toEqual([]);
  });

  it("uses %APPDATA%\\Claude on Windows and creates the file", async () => {
    f = await fixture("win32");
    const appData = join(f.root, "AppData", "Roaming");
    f.deps.env = { APPDATA: appData };

    expect(await runInstall(["claude-desktop"], f.deps)).toBe(0);

    const config = JSON.parse(await readFile(join(appData, "Claude", "claude_desktop_config.json"), "utf8"));
    expect(config.mcpServers.tripezgo.command).toBe(NODE);
  });

  it("refuses to overwrite a config file it can't parse", async () => {
    f = await fixture("darwin");
    const dir = join(f.home, "Library", "Application Support", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "claude_desktop_config.json"), "{ not json");

    expect(await runInstall(["claude-desktop"], f.deps)).toBe(1);
    expect(await readFile(join(dir, "claude_desktop_config.json"), "utf8")).toBe("{ not json");
    expect(f.out.join("\n")).toMatch(/isn't valid JSON/);
  });
});
