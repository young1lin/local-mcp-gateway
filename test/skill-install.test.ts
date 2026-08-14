import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "../src/skill-install.js";
import { skillDir } from "../src/skilldir.js";
import { parseArgv, run, type Io, type Ops } from "../src/cli.js";

function io(): Io & { text: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

const SKILL_TARGETS = [
  "~/.agents/skills/local-mcp-gateway",
  "~/.claude/skills/local-mcp-gateway",
  "~/.cursor/skills/local-mcp-gateway",
];

/** Just enough Ops for `lmg skill`; records the call so the test can see the dispatch happened. */
function ops(): Ops & { skillCalls: number } {
  const o: Ops & { skillCalls: number } = {
    skillCalls: 0,
    port: () => 19999,
    start: async () => ({ status: "started", pid: 1, port: 19999, url: "http://127.0.0.1:19999/" }),
    stop: async () => ({ status: "stopped", pid: 1, port: 19999 }),
    status: async () => ({ running: false, port: 19999, logFile: "x.log" }),
    logs: async () => undefined,
    open: () => undefined,
    token: () => "tok",
    creds: () => ({ url: "http://127.0.0.1:19999/", user: "admin", pass: "x", token: "tok" }),
    foreground: async () => undefined,
    skillInstall: () => {
      o.skillCalls += 1;
      return SKILL_TARGETS;
    },
  };
  return o;
}

describe("skillDir", () => {
  it("points at the shipped skill in this package", () => {
    const skill = readFileSync(join(skillDir(), "SKILL.md"), "utf8");
    expect(skill).toContain("name: local-mcp-gateway");
    expect(skill).toContain("disable-model-invocation: true");
  });
});

describe("installSkill", () => {
  const home = mkdtempSync(join(tmpdir(), "lmg-skill-"));
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("copies the skill into ~/.agents/skills, ~/.claude/skills and ~/.cursor/skills", () => {
    const targets = installSkill(home);
    expect(targets).toHaveLength(3);
    for (const t of targets) {
      const skill = readFileSync(join(t, "SKILL.md"), "utf8");
      expect(skill).toContain("name: local-mcp-gateway");
    }
  });

  it("is idempotent — a re-run refreshes rather than fails", () => {
    expect(() => installSkill(home)).not.toThrow();
  });

  it("fails loud when the package has no skill to install", () => {
    expect(() => installSkill(home, join(home, "no-such-skill"))).toThrow(/skill not found/);
  });
});

describe("lmg skill (CLI)", () => {
  it("parses the subcommand", () => {
    expect(parseArgv(["skill", "install"])).toMatchObject({ cmd: "skill", skillSub: "install" });
    const bare = parseArgv(["skill"]);
    expect(bare.cmd).toBe("skill");
    expect(bare.skillSub).toBeUndefined();
  });

  it("skill install dispatches and prints the targets it wrote", async () => {
    const i = io();
    const o = ops();
    const code = await run(["skill", "install"], i, o);
    expect(code).toBe(0);
    expect(o.skillCalls).toBe(1);
    for (const t of SKILL_TARGETS) expect(i.text()).toContain(t);
  });

  it("a missing or bogus subcommand is refused", async () => {
    const noSub = io();
    expect(await run(["skill"], noSub, ops())).toBe(1);
    expect(noSub.errText()).toMatch(/usage: lmg skill install/);

    const bogus = io();
    expect(await run(["skill", "bogus"], bogus, ops())).toBe(1);
    expect(bogus.errText()).toMatch(/unknown skill subcommand: bogus/);
  });
});
