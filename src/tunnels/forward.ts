import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { log } from "../log.js";
import { waitForRelease } from "./port.js";
import { TunnelError, type ForwardStats } from "./types.js";

/** Opens one channel to the remote target. Injected, so Forward is testable with no SSH at all. */
export type ChannelOpener = (host: string, port: number) => Promise<Duplex>;

export interface ForwardTarget {
  localPort: number;
  targetHost: string;
  targetPort: number;
}

export interface ForwardOptions {
  /** Cap on concurrent local sockets, so one runaway client cannot exhaust the heap or SSH channels. */
  maxSockets?: number;
  host?: string;
}

const DEFAULT_MAX_SOCKETS = 200;

/**
 * One forwarding rule's local listener.
 *
 * The contract that matters, and the reason this class owns the socket set: a local port stays bound
 * only while the tunnel can actually carry traffic. `close()` therefore closes the listener AND
 * destroys every accepted socket AND verifies the port is rebindable — a lingering accepted socket is
 * exactly what keeps a "dead" port occupied, which is the failure the old tool shipped with (an app
 * connects successfully and then hangs, and the port cannot be reused until the tool restarts).
 */
export class Forward {
  private server?: Server;
  private sockets = new Set<Socket>();
  /** Bytes from sockets that have already closed; live ones are added in stats(). */
  private closedIn = 0;
  private closedOut = 0;
  private channelFailures = 0;
  private refused = 0;
  private lastError?: string;
  private readonly maxSockets: number;
  private readonly host: string;

  constructor(private target: ForwardTarget, private open: ChannelOpener, opts: ForwardOptions = {}) {
    this.maxSockets = opts.maxSockets ?? DEFAULT_MAX_SOCKETS;
    this.host = opts.host ?? "127.0.0.1";
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  /** Bind the local port. Throws TunnelError(kind:"port") when something already holds it. */
  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on("connection", (socket) => this.accept(socket));
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeAllListeners();
        this.server = undefined;
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          reject(new TunnelError(`local port ${this.target.localPort} is not available (${err.code})`, "port", {
            port: this.target.localPort,
            code: err.code,
          }));
          return;
        }
        reject(new TunnelError(`listen on ${this.host}:${this.target.localPort} failed: ${err.message}`, "port"));
      };
      server.once("error", onError);
      // `exclusive` so a second binder is refused rather than silently sharing the port on Windows.
      server.listen({ port: this.target.localPort, host: this.host, exclusive: true }, () => {
        server.removeListener("error", onError);
        // Past startup, a listener error must not be an unhandled event that takes the process down.
        server.on("error", (err) => {
          this.lastError = err.message;
          log("warn", "tunnel listener error", { port: this.target.localPort, err: err.message });
        });
        this.server = server;
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= this.maxSockets) {
      this.refused++;
      this.lastError = `refused: ${this.maxSockets} concurrent connections already open`;
      socket.destroy();
      return;
    }
    // A client that vanishes without a FIN would otherwise hold a socket — and its SSH channel —
    // forever. No idle timeout: an idle DB pool socket is legitimate and must not be reaped.
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.on("close", () => {
      this.closedIn += socket.bytesRead;
      this.closedOut += socket.bytesWritten;
      this.sockets.delete(socket);
    });
    // Both halves of a proxied pair routinely die mid-transfer (ECONNRESET on either side); that is
    // normal traffic, not a fault worth surfacing.
    socket.on("error", () => socket.destroy());

    void this.open(this.target.targetHost, this.target.targetPort).then(
      (channel) => {
        // The client may have given up while the channel was opening.
        if (socket.destroyed) {
          channel.destroy?.();
          return;
        }
        channel.on("error", () => socket.destroy());
        socket.once("close", () => channel.destroy?.());
        socket.pipe(channel);
        channel.pipe(socket);
      },
      (err: Error) => {
        // The remote target refused the channel. That is this one connection's failure, not the
        // tunnel's: SSH is fine, so the listener stays up and the rule stays reported as up.
        this.channelFailures++;
        this.lastError = err.message;
        socket.destroy();
      },
    );
  }

  /**
   * Stop accepting, destroy every accepted socket, and wait until the port can be bound again.
   *
   * All three steps are the point. Closing the listener alone leaves established sockets holding the
   * port, and returning before the OS has released it makes an immediate restart fail with
   * EADDRINUSE against nothing.
   */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    // Start the close, then destroy the sockets, THEN await it. Order is not cosmetic:
    // `server.close()`'s callback waits for every accepted connection to end, so awaiting it before
    // destroying them hangs forever the moment a rule has one live client — measured, not theorised.
    // The gateway's own listener carries the same scar (see index.ts's shutdown comment).
    const closed = server
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    for (const socket of [...this.sockets]) {
      this.closedIn += socket.bytesRead;
      this.closedOut += socket.bytesWritten;
      socket.destroy();
    }
    this.sockets.clear();
    await closed;
    if (server) {
      const free = await waitForRelease(this.target.localPort, this.host);
      if (!free) {
        log("warn", "tunnel port still held after close", { port: this.target.localPort });
      }
    }
  }

  stats(): ForwardStats {
    let bytesIn = this.closedIn;
    let bytesOut = this.closedOut;
    for (const s of this.sockets) {
      bytesIn += s.bytesRead;
      bytesOut += s.bytesWritten;
    }
    return {
      sockets: this.sockets.size,
      bytesIn,
      bytesOut,
      channelFailures: this.channelFailures,
      refused: this.refused,
      lastError: this.lastError,
    };
  }
}
