import { describe, it, expect } from "vitest";
import { mcpLoopbackPort } from "../src/tunnels/mcpmatch.js";

describe("mcpLoopbackPort", () => {
  it("reads host and port off mysql and redis defs, with their standard defaults", () => {
    expect(mcpLoopbackPort({ type: "mysql", host: "localhost", port: 3307 })).toBe(3307);
    expect(mcpLoopbackPort({ type: "mysql", host: "localhost" })).toBe(3306);
    expect(mcpLoopbackPort({ type: "mysql" })).toBe(3306); // host defaults to localhost in the adapter
    expect(mcpLoopbackPort({ type: "redis", host: "127.0.0.1", port: 6380 })).toBe(6380);
    expect(mcpLoopbackPort({ type: "redis" })).toBe(6379);
  });

  it("parses host and port out of a Postgres url", () => {
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://u:p@127.0.0.1:5433/db?sslmode=disable" })).toBe(5433);
    expect(mcpLoopbackPort({ type: "pg", url: "postgres://u@localhost/db" })).toBe(5432);
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://127.0.0.1:5432/db" })).toBe(5432);
    // No path, only a query string: the authority used to swallow "5433?sslmode=require" as the host.
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://u:p@127.0.0.1:5433?sslmode=require" })).toBe(5433);
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://u:p@localhost?sslmode=require" })).toBe(5432);
  });

  it("is not fooled by a password containing an @ or a colon", () => {
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://u:p@ss:w0rd@127.0.0.1:5433/db" })).toBe(5433);
  });

  it("resolves ${ENV} refs before matching, so a stored reference still matches", () => {
    process.env.TEST_PG_URL = "postgresql://u:p@127.0.0.1:5433/db";
    try {
      expect(mcpLoopbackPort({ type: "pg", url: "${TEST_PG_URL}" })).toBe(5433);
    } finally {
      delete process.env.TEST_PG_URL;
    }
  });

  it("ignores anything that is not loopback — a tunnel cannot be serving it", () => {
    expect(mcpLoopbackPort({ type: "mysql", host: "10.0.0.11", port: 3306 })).toBeUndefined();
    expect(mcpLoopbackPort({ type: "redis", host: "db.internal", port: 6379 })).toBeUndefined();
    expect(mcpLoopbackPort({ type: "pg", url: "postgresql://u:p@203.0.113.10:5432/db" })).toBeUndefined();
  });

  it("never guesses for proc or echo MCPs", () => {
    expect(mcpLoopbackPort({ type: "proc", command: "npx server --port 5433" })).toBeUndefined();
    expect(mcpLoopbackPort({ type: "echo" })).toBeUndefined();
  });

  it("returns undefined for a pg def with no url rather than inventing 5432", () => {
    expect(mcpLoopbackPort({ type: "pg" })).toBeUndefined();
    expect(mcpLoopbackPort({ type: "pg", url: "" })).toBeUndefined();
    expect(mcpLoopbackPort({ type: "pg", url: "not-a-url" })).toBeUndefined();
  });
});
