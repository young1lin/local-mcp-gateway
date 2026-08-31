import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { probePort, waitForRelease, portOwner, forceFree } from "../src/tunnels/port.js";

/** Bind a listener on an OS-assigned port and hand back both. */
function squat(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

describe("probePort", () => {
  it("reports a bound port as taken and a free one as free", async () => {
    const { server, port } = await squat();
    expect(await probePort(port)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probePort(port)).toBe(true);
  });
});

describe("waitForRelease", () => {
  it("returns as soon as the port frees up", async () => {
    const { server, port } = await squat();
    setTimeout(() => server.close(), 120);
    const t0 = Date.now();
    expect(await waitForRelease(port, "127.0.0.1", 3000, 25)).toBe(true);
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(ms).toBeLessThan(1500); // did not sit out the whole budget
  });

  it("gives up after its budget when the port stays held", async () => {
    const { server, port } = await squat();
    const t0 = Date.now();
    expect(await waitForRelease(port, "127.0.0.1", 200, 25)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns immediately for a port nobody holds", async () => {
    const { server, port } = await squat();
    await new Promise<void>((r) => server.close(() => r()));
    const t0 = Date.now();
    expect(await waitForRelease(port, "127.0.0.1", 2000, 50)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe("portOwner", () => {
  it.runIf(process.platform === "win32")("finds this test process holding its own listener", async () => {
    const { server, port } = await squat();
    try {
      const owner = await portOwner(port);
      expect(owner).not.toBeNull();
      expect(owner!.pid).toBe(process.pid);
      // The image name comes from a `tasklist` subprocess (5s cap in port.ts); under full-suite load
      // it can come back empty, and portOwner then names the holder by its designed fallback
      // `pid <n>`. Both spellings identify this process — accept either.
      const name = owner!.name.toLowerCase();
      expect(name.includes("node") || owner!.name === `pid ${process.pid}`).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20000);

  it("returns null for a port nobody listens on", async () => {
    const { server, port } = await squat();
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portOwner(port)).toBeNull();
  }, 20000);
});

describe("forceFree", () => {
  it("refuses to kill the gateway itself", async () => {
    await expect(forceFree(process.pid)).rejects.toThrow(/refusing/i);
    await expect(forceFree(0)).rejects.toThrow(/refusing/i);
  });
});
