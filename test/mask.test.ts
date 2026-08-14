import { describe, it, expect } from "vitest";
import { maskDef, unmaskBody } from "../src/mask.js";

const MASK = "••••••••";

describe("maskDef", () => {
  it("masks a credential passed on a proc command line", () => {
    const out = maskDef({ type: "proc", command: "npx -y @foo/mcp --token=abc123 --port 7" });
    expect(out.command).toBe(`npx -y @foo/mcp --token=${MASK} --port 7`);
  });

  it("masks the space-separated and mysql -p forms too", () => {
    expect(maskDef({ type: "proc", command: "srv --api-key sk-live-1 --verbose" }).command)
      .toBe(`srv --api-key ${MASK} --verbose`);
    expect(maskDef({ type: "proc", command: "mysql -h db -uroot -phunter2 --database=prod" }).command)
      .toBe(`mysql -h db -uroot -p${MASK} --database=prod`);
  });

  it("leaves a command with no credential alone", () => {
    const cmd = "npx -y @modelcontextprotocol/server-filesystem /srv/data";
    expect(maskDef({ type: "proc", command: cmd }).command).toBe(cmd);
  });

  it("keeps ${ENV} references as references", () => {
    expect(maskDef({ type: "proc", command: "srv --token=${FOO_TOKEN}" }).command)
      .toBe("srv --token=${FOO_TOKEN}");
  });

  // A remote MCP's API key lives in a request header — the same place a proc MCP's key lives on the
  // command line, and just as much a credential.
  it("masks a credential carried in a request header", () => {
    const out = maskDef({
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer sk-live-1", "X-Trace": "on" },
    });
    expect((out.headers as Record<string, string>).Authorization).toBe(MASK);
    expect((out.headers as Record<string, string>)["X-Trace"]).toBe("on");
  });

  it("keeps a ${ENV} reference in a header as a reference", () => {
    const out = maskDef({ type: "http", url: "https://x.test/mcp", headers: { Authorization: "${CONTEXT7_API_KEY}" } });
    expect((out.headers as Record<string, string>).Authorization).toBe("${CONTEXT7_API_KEY}");
  });
});

describe("unmaskBody", () => {
  it("restores a masked command from what is stored", () => {
    const current = { type: "proc", command: "npx -y @foo/mcp --token=abc123" };
    const body = { type: "proc", command: `npx -y @foo/mcp --token=${MASK}` };
    expect(unmaskBody(body, current).command).toBe("npx -y @foo/mcp --token=abc123");
  });

  it("keeps an edit made around the masked credential", () => {
    const current = { type: "proc", command: "srv --token=abc123 --port 7" };
    const body = { type: "proc", command: `srv --token=${MASK} --port 9` };
    expect(unmaskBody(body, current).command).toBe("srv --token=abc123 --port 9");
  });

  it("never persists the sentinel when there is nothing stored to restore", () => {
    // The panel's type dropdown can submit a pg `url` against a stored mysql def, where no `url`
    // exists to restore from — writing the sentinel would replace the credential with dots.
    const current = { type: "mysql", host: "h", password: "hunter2" };
    const out = unmaskBody({ type: "pg", url: `postgresql://u:${MASK}@h:5432/d` }, current);
    expect(JSON.stringify(out)).not.toContain(MASK);
    expect(out.url).toBeUndefined();
  });

  it("drops a bare sentinel typed into a field with no stored value", () => {
    const out = unmaskBody({ type: "mysql", host: "h", password: MASK }, { type: "mysql", host: "h" });
    expect(out.password).toBeUndefined();
  });

  it("still restores a stored password and url", () => {
    expect(unmaskBody({ password: MASK }, { type: "mysql", password: "hunter2" }).password).toBe("hunter2");
    expect(unmaskBody({ url: `postgresql://u:${MASK}@h:5432/d` }, { type: "pg", url: "postgresql://u:real@h:5432/d" }).url)
      .toBe("postgresql://u:real@h:5432/d");
  });

  it("restores a masked env value and drops one with no stored counterpart", () => {
    const out = unmaskBody(
      { env: { API_TOKEN: MASK, NEW_SECRET: MASK } },
      { type: "proc", command: "x", env: { API_TOKEN: "abc" } },
    );
    expect((out.env as Record<string, unknown>).API_TOKEN).toBe("abc");
    expect((out.env as Record<string, unknown>).NEW_SECRET).toBeUndefined();
  });

  // Saving the form after editing an unrelated field must not replace the remote's API key with dots.
  it("restores a masked header and drops one with no stored counterpart", () => {
    const out = unmaskBody(
      { headers: { Authorization: MASK, "X-New-Token": MASK } },
      { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer real" } },
    );
    expect((out.headers as Record<string, unknown>).Authorization).toBe("Bearer real");
    expect((out.headers as Record<string, unknown>)["X-New-Token"]).toBeUndefined();
  });
});
