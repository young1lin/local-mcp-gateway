import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

// Minimal stdio MCP server used to test the proxy adapter.
// Run with: node stdio-echo.mjs   (or MY_ECHO_TAG=... node stdio-echo.mjs)
const tag = process.env.MY_ECHO_TAG || "stdio-echo";
const server = new Server({ name: "stdio-echo", version: "1.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: "echo",
    description: "echoes the message back, prefixed with the tag",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  }],
}));

server.setRequestHandler('tools/call', async (req) => ({
  content: [{ type: "text", text: `${tag}:${String(req.params.arguments?.msg ?? "")}` }],
}));

server.setRequestHandler('resources/list', async () => ({
  resources: [{ uri: `echo://${tag}`, name: tag, description: "an echo resource" }],
}));

server.setRequestHandler('resources/read', async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: "text/plain", text: `resource ${req.params.uri}` }],
}));

server.setRequestHandler('prompts/list', async () => ({
  prompts: [{
    name: "greet",
    description: "a greeting prompt",
    arguments: [{ name: "who", description: "who to greet", required: true }],
  }],
}));

await server.connect(new StdioServerTransport());
