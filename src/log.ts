export function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, extra }));
}
