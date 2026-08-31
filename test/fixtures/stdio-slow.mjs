import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

// Minimal stdio MCP server whose one tool sleeps for a caller-supplied number of
// milliseconds. Used to test the proc adapter's call timeout: a real vision/inference
// MCP that runs past the deadline is indistinguishable from this, and far slower to run.
const server = new Server({ name: "stdio-slow", version: "1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: "slow",
    description: "sleeps for `ms` milliseconds, then returns done",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
  }],
}));

server.setRequestHandler('tools/call', async (req) => {
  const ms = Number(req.params.arguments?.ms ?? 0);
  await new Promise((r) => setTimeout(r, ms));
  return { content: [{ type: "text", text: `done after ${ms}ms` }] };
});

await server.connect(new StdioServerTransport());
