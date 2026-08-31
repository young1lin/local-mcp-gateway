// A stand-in third-party adapter module: exports createAdapter(def, name) -> Adapter, the
// contract src/adapters/factory.ts documents for `"adapter": "<module>"` config entries.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";

const makeServer = (name, type) => new Server({ name: name ?? type, version: "1.0" }, { capabilities: { tools: {} } });

export function createAdapter(def, name) {
  return {
    type: def.type,
    async build() {
      return makeServer(name, def.type);
    },
    makeServer() {
      return makeServer(name, def.type);
    },
    async ping() {
      if (def.pingError) throw new Error(String(def.pingError));
    },
    async close() {
      // A marker file is how the test observes delegation: the adapter object itself is opaque
      // behind ExternalAdapter.
      if (def.closedMarker) writeFileSync(def.closedMarker, "closed");
    },
    rename(next) {
      name = next;
    },
  };
}
