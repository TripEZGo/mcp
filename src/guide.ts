import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The trip-planning skill, served as a tool. Claude Desktop can't read a skills folder; this is how it gets
 * the same guide Claude Code and Codex read from disk.
 */
export interface PlanningGuide {
  /** Reference names, e.g. `planning` for `references/planning.md`. */
  readonly topics: readonly string[];
  /** SKILL.md (without its front matter) followed by every reference. */
  full(): string;
  topic(name: string): string | undefined;
}

/** Reads the skill once, at start: a later self-update may remove this version's folder while it runs. */
export function loadGuide(skillDir: string): PlanningGuide {
  let skill: string;
  try {
    skill = stripFrontMatter(readFileSync(join(skillDir, "SKILL.md"), "utf8")).trim();
  } catch {
    return emptyGuide(`The planning guide is missing from this install (${skillDir}).`);
  }
  const references = new Map<string, string>();
  try {
    for (const file of readdirSync(join(skillDir, "references")).filter((f) => f.endsWith(".md")).sort()) {
      references.set(file.slice(0, -3), readFileSync(join(skillDir, "references", file), "utf8").trim());
    }
  } catch {
    // A skill without references is still a guide.
  }
  const topics = [...references.keys()];
  const full = [
    skill,
    ...topics.map((name) => `---\n\n<!-- references/${name}.md (get_planning_guide topic "${name}") -->\n\n${references.get(name)}`),
  ].join("\n\n");
  return { topics, full: () => full, topic: (name) => references.get(name) };
}

function emptyGuide(message: string): PlanningGuide {
  return { topics: [], full: () => message, topic: () => undefined };
}

function stripFrontMatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}
