import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAttachmentFromPath } from "../src/upload.js";
import { FakeApp, json } from "./fakeApp.js";

const TOKEN = "tok_paths";

describe("add_attachment_from_path refuses paths that hold secrets", () => {
  let app: FakeApp;
  let baseUrl: string;
  let root: string;
  let home: string;
  let work: string;

  beforeEach(async () => {
    app = new FakeApp(TOKEN);
    app.handler = () => json(200, { attachmentId: "A-1", name: "x", byteCount: 1 });
    baseUrl = await app.start();
    root = await mkdtemp(join(tmpdir(), "tripezgo-paths-"));
    home = join(root, "home");
    work = join(home, "Documents");
    await mkdir(work, { recursive: true });
    // `~` is the fake home, so nothing here touches the real one.
    vi.stubEnv("HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function refused(path: string): Promise<string> {
    const result = await addAttachmentFromPath({ path }, { baseUrl, token: TOKEN });
    expect(result.isError).toBe(true);
    expect(app.requests).toHaveLength(0);
    return (result.content[0] as { text: string }).text;
  }

  async function file(path: string, content = "secret"): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  it("still uploads an ordinary file, a name with inner dots, and a symlink to one", async () => {
    const plain = await file(join(work, "boarding.pass.v2.pdf"));
    expect((await addAttachmentFromPath({ path: plain }, { baseUrl, token: TOKEN })).isError).toBeFalsy();
    await symlink(plain, join(work, "alias.pdf"));
    expect((await addAttachmentFromPath({ path: join(work, "alias.pdf") }, { baseUrl, token: TOKEN })).isError).toBeFalsy();
    expect((await addAttachmentFromPath({ path: "~/Documents/boarding.pass.v2.pdf" }, { baseUrl, token: TOKEN })).isError).toBeFalsy();
    expect(app.requests).toHaveLength(3);
  });

  it("refuses a dotfile, and says why", async () => {
    const message = await refused(await file(join(work, ".env")));
    expect(message).toContain(".env");
    expect(message).toMatch(/hidden/i);
    expect(message).toMatch(/credentials|passwords/i);
  });

  it("refuses any file inside a dot folder", async () => {
    await refused(await file(join(work, ".private", "notes", "a.txt")));
    await refused(await file(join(home, ".netrc")));
  });

  it("refuses ~/.ssh, ~/.aws, ~/.gnupg, ~/.config and ~/Library/Keychains, spelled with ~ or in full", async () => {
    const targets = [
      [".ssh", "id_ed25519"],
      [".aws", "credentials"],
      [".gnupg", "secring.gpg"],
      [".config", "gh/hosts.yml"],
      ["Library/Keychains", "login.keychain-db"],
    ];
    for (const [dir, name] of targets) {
      const path = await file(join(home, dir, name));
      const message = await refused(path);
      expect(message).toMatch(/credentials|passwords/i);
      await refused(`~/${dir}/${name}`);
    }
  });

  it("refuses ~/Library/Keychains however its case is spelled", async () => {
    const path = await file(join(home, "Library", "Keychains", "login.keychain-db"));
    await refused(path.replace("Library/Keychains", "library/keychains"));
  });

  it("follows a symlink before judging: a harmless name that points into a secret folder is refused", async () => {
    const key = await file(join(home, ".ssh", "id_rsa"));
    await symlink(key, join(work, "holiday.jpg"));
    const message = await refused(join(work, "holiday.jpg"));
    expect(message).toContain(".ssh");
    await symlink(join(home, "Library", "Keychains"), join(work, "folder"));
    await file(join(home, "Library", "Keychains", "login.keychain-db"));
    await refused(join(work, "folder", "login.keychain-db"));
  });

  it("resolves .. before judging", async () => {
    await file(join(home, ".ssh", "id_rsa"));
    await refused(join(work, "..", ".ssh", "id_rsa"));
    await refused(join(work, "..", "Documents", "..", ".ssh", "id_rsa"));
  });

  it("a missing file in a secret folder says nothing about whether it exists", async () => {
    const message = await refused(join(home, ".ssh", "id_rsa"));
    expect(message).toMatch(/hidden|credentials/i);
  });
});
