import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Server } from "@modelcontextprotocol/server";

/**
 * Open a throwaway in-memory MCP session against an already-built Server and return the Client.
 * The caller must close the client when done; the server itself is left running. Used by the
 * paging endpoints (tools/resources browsing).
 */
export async function openSession(server: Server): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gateway-introspect", version: "1" }, { capabilities: {} });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}
