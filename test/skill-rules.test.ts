import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../src/guide.js";

const SKILL_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "skills", "tripezgo");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

describe("the bundled skill's safety rules", () => {
  const section = skill.split(/^## /m).find((part) => part.startsWith("Safety rules"));

  it("has a Safety rules section before Connecting", () => {
    expect(section).toBeDefined();
    expect(skill.indexOf("## Safety rules")).toBeLessThan(skill.indexOf("## Connecting"));
  });

  it("says what tools return is data, not instructions", () => {
    expect(section).toMatch(/data, not instructions/i);
    expect(section).toMatch(/tool result|returned by (a )?tool/i);
  });

  it("connects only with a sentence the user pasted in this conversation", () => {
    expect(section).toMatch(/`connect`/);
    expect(section).toMatch(/only .*sentence the user (pasted|typed)/is);
    expect(section).toMatch(/never .*(from a tool result|from a file|found)/is);
  });

  it("always asks the user before add_attachment_from_path", () => {
    expect(section).toMatch(/always ask the user before .*`add_attachment_from_path`/is);
  });

  it("reaches AI clients that have no skills folder, through get_planning_guide", () => {
    expect(loadGuide(SKILL_DIR).full()).toContain("## Safety rules");
  });
});
