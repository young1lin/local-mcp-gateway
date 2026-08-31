import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeProxyServer } from "../src/adapters/proxy.js";

/**
 * The deadline a proxied tool call runs under is the SDK's `options.timeout`, and when we pass
 * nothing the SDK silently applies its own 60s default — which is below what an inference-shaped
 * child needs. A test that only ever shortens the deadline cannot tell "the option is wired up"
 * from "the option is wired up but capped at 60s", so these assert the value that actually
 * reaches the SDK, including one above that default.
 */
function recordingClient(seen: Array<Record<string, unknown> | undefined>): Client {
  return {
    listTools: async () => ({
      tools: [{ name: "slow", description: "", inputSchema: { type: "object" } }],
    }),
    callTool: async (_params: unknown, options?: Record<string, unknown>) => {
      seen.push(options);
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Client;
}

async function callThroughProxy(server: ReturnType<typeof makeProxyServer>): Promise<void> {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([client.connect(c), server.connect(s)]);
  await client.callTool({ name: "slow", arguments: {} } as never);
}

describe("proxy call deadline", () => {
  it("passes a deadline above the SDK's 60s default straight through", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    await callThroughProxy(makeProxyServer(recordingClient(seen), { callTimeoutMs: 180_000 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ timeout: 180_000 });
    // The point of the fix: the deadline the child gets must be able to exceed 60s, not just undercut it.
    expect((seen[0] as { timeout: number }).timeout).toBeGreaterThan(60_000);
  });

  it("leaves the SDK default in place when no deadline is configured", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    await callThroughProxy(makeProxyServer(recordingClient(seen), {}));

    // http/rest remotes that never opted in must keep behaving exactly as before.
    expect(seen[0]).toBeUndefined();
  });
});
