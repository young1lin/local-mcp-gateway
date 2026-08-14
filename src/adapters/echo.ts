import { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./types.js";
import { logged } from "../calls.js";

/** Build a fresh in-process echo Server (one tool: `echo`). Used for tests + as a health probe.
 *
 * A named server (what the factory builds from the registry) logs its tool calls like every other
 * adapter; the nameless singleton below stays unlogged, which `recordCall` already handles. */
function createEchoServer(name?: string): Server {
  const server = new Server({ name: "echo", version: "1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: "echo",
      description: "echo back the message",
      inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    }],
  }));
  server.setRequestHandler('tools/call', async (req) =>
    // Wrapped so the panel's Logs tab shows echo calls too — the shipped demo MCP is the first one
    // a new user clicks, and an empty log there reads like a broken log.
    logged(
      name,
      req.params.name,
      req.params.arguments,
      async () => ({
        content: [{ type: "text", text: String(req.params.arguments?.msg ?? "") }],
      }),
      (result) => ({
        ok: true,
        output: result.content.map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`)).join("\n"),
      }),
    ),
  );
  return server;
}

/** A named echo adapter: calls land in the Logs tab under this MCP's name. */
export function makeEchoAdapter(name?: string): Adapter {
  return {
    type: "echo",
    async build() {
      return createEchoServer(name);
    },
    // Fresh server per request so concurrent requests don't share a single transport-bound Server.
    makeServer() {
      return createEchoServer(name);
    },
  };
}

/** Nameless singleton for tests — not call-logged (recordCall drops an unnamed MCP). */
export const echoAdapter: Adapter = makeEchoAdapter();
