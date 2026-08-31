import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect, createConnection, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Forward } from "../src/tunnels/forward.js";
import { probePort } from "../src/tunnels/port.js";
import { TunnelError } from "../src/tunnels/types.js";

/** Stands in for the remote service: echoes back everything, upper-cased. */
let echo: Server;
let echoPort = 0;
const live = new Set<Socket>();

beforeEach(async () => {
  echo = createServer((s) => {
    live.add(s);
    s.on("close", () => live.delete(s));
    s.on("error", () => s.destroy());
    s.on("data", (b) => s.write(b.toString("utf8").toUpperCase()));
  });
  await new Promise<void>((r) => echo.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  for (const s of [...live]) s.destroy();
  await new Promise<void>((r) => echo.close(() => r()));
});

/** The injected opener: a plain TCP connection to the echo server plays the role of an SSH channel. */
function tcpOpener(): (host: string, port: number) => Promise<Duplex> {
  return (host, port) =>
    new Promise((resolve, reject) => {
      const s = createConnection({ host, port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
}

/** An OS-assigned free port: bind, read the number, release it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port });
    let out = "";
    c.setTimeout(4000, () => { c.destroy(); reject(new Error("timeout")); });
    c.on("connect", () => c.write(text));
    c.on("data", (b) => {
      out += b.toString("utf8");
      if (out.length >= text.length) { c.end(); resolve(out); }
    });
    c.on("error", reject);
  });
}

describe("Forward traffic", () => {
  it("carries bytes both ways and counts them", async () => {
    const port = await freePort();
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    await f.listen();
    try {
      expect(await roundTrip(port, "hello")).toBe("HELLO");
      // The socket's close is what banks its byte counts, so give the event loop a turn.
      await new Promise((r) => setTimeout(r, 60));
      const s = f.stats();
      expect(s.bytesIn).toBeGreaterThanOrEqual(5);
      expect(s.bytesOut).toBeGreaterThanOrEqual(5);
      expect(s.channelFailures).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("reports live socket count while a connection is open", async () => {
    const port = await freePort();
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    await f.listen();
    const c = connect({ host: "127.0.0.1", port });
    try {
      await new Promise<void>((r) => c.once("connect", () => r()));
      await new Promise((r) => setTimeout(r, 40));
      expect(f.stats().sockets).toBe(1);
    } finally {
      c.destroy();
      await f.close();
    }
  });
});

describe("Forward port lifecycle", () => {
  it("reports a taken port as a TunnelError of kind port, not a raw EADDRINUSE", async () => {
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: "127.0.0.1", exclusive: true }, () => r()));
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    try {
      await expect(f.listen()).rejects.toThrow(TunnelError);
      await expect(f.listen()).rejects.toThrow(/local port \d+ is not available \(EADDRINUSE\)/);
      expect(f.listening).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("frees the port on close even with an established connection open", async () => {
    const port = await freePort();
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    await f.listen();
    const held = connect({ host: "127.0.0.1", port });
    await new Promise<void>((r) => held.once("connect", () => r()));
    // An accepted socket left alive is exactly what used to keep a dead port occupied.
    expect(await probePort(port)).toBe(false);
    await f.close();
    expect(await probePort(port)).toBe(true);
    expect(f.listening).toBe(false);
    held.destroy();
  });

  it("can be re-listened immediately after close, without racing its own release", async () => {
    const port = await freePort();
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    for (let i = 0; i < 3; i++) {
      await f.listen();
      expect(await roundTrip(port, "x")).toBe("X");
      await f.close();
    }
  });

  it("closes cleanly when it never listened", async () => {
    const f = new Forward({ localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener());
    await expect(f.close()).resolves.toBeUndefined();
  });
});

describe("Forward failure handling", () => {
  it("keeps listening when the remote refuses a channel, and counts the failure", async () => {
    const port = await freePort();
    let attempts = 0;
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, () => {
      attempts++;
      return Promise.reject(new Error("channel open failed: administratively prohibited"));
    });
    await f.listen();
    try {
      // The local connection is accepted and then dropped: SSH is fine, the target is not.
      const c = connect({ host: "127.0.0.1", port });
      await new Promise<void>((r) => c.once("close", () => r()));
      expect(attempts).toBe(1);
      const s = f.stats();
      expect(s.channelFailures).toBe(1);
      expect(s.lastError).toMatch(/administratively prohibited/);
      expect(f.listening).toBe(true); // the rule stays up — only this connection failed
    } finally {
      await f.close();
    }
  });

  it("refuses connections past the socket cap instead of opening unbounded channels", async () => {
    const port = await freePort();
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, tcpOpener(), { maxSockets: 2 });
    await f.listen();
    const open: Socket[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = connect({ host: "127.0.0.1", port });
        await new Promise<void>((r) => c.once("connect", () => r()));
        open.push(c);
      }
      await new Promise((r) => setTimeout(r, 40));
      expect(f.stats().sockets).toBe(2);
      const extra = connect({ host: "127.0.0.1", port });
      await new Promise<void>((r) => extra.once("close", () => r()));
      expect(f.stats().refused).toBe(1);
      expect(f.stats().lastError).toMatch(/2 concurrent connections/);
    } finally {
      for (const c of open) c.destroy();
      await f.close();
    }
  });

  it("destroys a channel that arrives after the client gave up", async () => {
    const port = await freePort();
    let opened: Duplex | undefined;
    const f = new Forward({ localPort: port, targetHost: "127.0.0.1", targetPort: echoPort }, async (h, p) => {
      await new Promise((r) => setTimeout(r, 120)); // slow channel
      opened = await tcpOpener()(h, p);
      return opened;
    });
    await f.listen();
    try {
      const c = connect({ host: "127.0.0.1", port });
      await new Promise<void>((r) => c.once("connect", () => r()));
      c.destroy(); // give up before the channel is ready
      await new Promise((r) => setTimeout(r, 250));
      expect(opened).toBeDefined();
      expect(opened!.destroyed).toBe(true); // not leaked
    } finally {
      await f.close();
    }
  });
});
