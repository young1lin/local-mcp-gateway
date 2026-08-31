import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProcAdapter, tokenizeCommand, decodeChildOutput, PROC_CALL_TIMEOUT_MS } from "../src/adapters/proc.js";
import { clearCalls, readCalls, setCallLogDir } from "../src/calls.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "stdio-echo.mjs");
const slowFixture = join(here, "fixtures", "stdio-slow.mjs");

describe("tokenizeCommand", () => {
  it("splits and honors quotes", () => {
    expect(tokenizeCommand(`npx -y @scope/pkg arg`)).toEqual(["npx", "-y", "@scope/pkg", "arg"]);
    expect(tokenizeCommand(`node "C:\\a b\\x.js" --flag`)).toEqual(["node", "C:\\a b\\x.js", "--flag"]);
    expect(tokenizeCommand(`uvx mcp-server-git`)).toEqual(["uvx", "mcp-server-git"]);
  });
});

describe("decodeChildOutput", () => {
  it("keeps valid UTF-8, including CJK", () => {
    expect(decodeChildOutput(Buffer.from("hello 世界\n", "utf8"))).toBe("hello 世界\n");
  });

  it("decodes a GBK Windows 'not recognized as a command' line instead of mojibake", () => {
    // cmd.exe on a Chinese Windows (CP936) writing: 'uvx' 不是内部或外部命令，也不是可运行的程序或批处理文件。
    const gbk = Buffer.from(
      "27-75-76-78-27-20-B2-BB-CA-C7-C4-DA-B2-BF-BB-F2-CD-E2-B2-BF-C3-FC-C1-EE-A3-AC-D2-B2-B2-BB-CA-C7-BF-C9-D4-CB-D0-D0-B5-C4-B3-CC-D0-F2-BB-F2-C5-FA-B4-A6-C0-ED-CE-C4-BC-FE-A1-A3"
        .split("-").map((h) => parseInt(h, 16)),
    );
    expect(gbk.toString("utf8")).toContain("����"); // the panel's current bug
    expect(decodeChildOutput(gbk)).toBe("'uvx' 不是内部或外部命令，也不是可运行的程序或批处理文件。");
  });
});

describe("ProcAdapter (proxy)", () => {
  it("spawns a stdio MCP and proxies tools/resources/call", async () => {
    const adapter = new ProcAdapter({ command: `node "${fixture}"`, env: { MY_ECHO_TAG: "t1" } });
    const proxyServer = await adapter.build();

    // Introspect the proxy server over an in-memory transport.
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client.connect(c), proxyServer.connect(s)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t: any) => t.name)).toContain("echo");

    const res = await client.listResources();
    expect(res.resources.map((r: any) => r.uri)).toContain("echo://t1");

    const call = await client.callTool({ name: "echo", arguments: { msg: "hi" } } as never);
    expect((call.content as any[])[0].text).toBe("t1:hi");

    await adapter.close();
  }, 15000);

  it("logs a proxied tool call under the MCP name, and follows a rename", async () => {
    setCallLogDir(mkdtempSync(join(tmpdir(), "mcp-proc-calls-")));
    await clearCalls("t2");
    const adapter = new ProcAdapter({ name: "t2", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "t2" } });
    const proxyServer = await adapter.build();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client.connect(c), proxyServer.connect(s)]);

    await client.callTool({ name: "echo", arguments: { msg: "logged" } } as never);
    const logged = (await readCalls("t2")).calls[0];
    expect(logged).toMatchObject({ tool: "echo", ok: true, output: "t2:logged" });
    expect(logged.args).toContain("logged");

    // A renamed MCP keeps logging — under the new name, from a freshly made server.
    adapter.rename("t2b");
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client2.connect(c2), adapter.makeServer().connect(s2)]);
    await client2.callTool({ name: "echo", arguments: { msg: "after" } } as never);
    expect((await readCalls("t2b")).calls[0].output).toBe("t2:after");

    await clearCalls("t2");
    await clearCalls("t2b");
    await adapter.close();
  }, 15000);
});

describe("ProcAdapter close after the child is already gone", () => {
  it("does not tree-kill a PID whose process has exited", async () => {
    const adapter = new ProcAdapter({ command: `node "${fixture}"`, env: { MY_ECHO_TAG: "gone" } });
    await adapter.build();
    const [pid] = adapter.pids();
    expect(pid).toBeGreaterThan(0);

    // Kill the child out from under the adapter and wait for the exit to be observed. Windows is
    // free to hand that PID to something else from this moment on.
    process.kill(pid);
    for (let i = 0; i < 100 && adapter.childExited() !== true; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(adapter.childExited()).toBe(true);

    await adapter.close(); // must not taskkill /T /F whatever now holds that number
    expect(adapter.pids()).toEqual([]);
  });
});

describe("ProcAdapter call timeout", () => {
  it("fails a tool call that outruns the configured timeout", async () => {
    const adapter = new ProcAdapter({ command: `node "${slowFixture}"`, timeoutMs: 300 });
    const proxyServer = await adapter.build();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client.connect(c), proxyServer.connect(s)]);

    await expect(
      client.callTool({ name: "slow", arguments: { ms: 5000 } } as never),
    ).rejects.toThrow(/timed out/i);

    await adapter.close();
  }, 20000);

  it("lets a call that finishes inside the timeout through untouched", async () => {
    const adapter = new ProcAdapter({ command: `node "${slowFixture}"`, timeoutMs: 5000 });
    const proxyServer = await adapter.build();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client.connect(c), proxyServer.connect(s)]);

    const res = await client.callTool({ name: "slow", arguments: { ms: 200 } } as never);
    expect((res.content as any[])[0].text).toBe("done after 200ms");

    await adapter.close();
  }, 20000);

  it("defaults to a deadline longer than the SDK's 60s, which cut real inference calls short", () => {
    expect(PROC_CALL_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
