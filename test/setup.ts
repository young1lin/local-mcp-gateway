import { config } from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

config();

// Every gateway state file is sealed with a machine-bound master key. Tests pin the key
// explicitly so the suite never spawns powershell / security / secret-tool, and pin an isolated
// data dir so no test (some of which migrate plaintext files by reading them) can ever touch the
// real ~/.mcp-gateway on the machine running the suite.
process.env.MCP_GATEWAY_MASTER_KEY = "ab".repeat(32);
process.env.MCP_GATEWAY_HOME = mkdtempSync(join(tmpdir(), "mcpgw-test-home-"));
