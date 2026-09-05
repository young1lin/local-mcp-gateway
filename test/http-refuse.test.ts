import { describe, it, expect } from "vitest";
import request from "supertest";
import { Router, type Handler } from "../src/http.js";

describe("Handler.refuse", () => {
  it("answers the refusal without reading the body or running the handler", async () => {
    const r = new Router();
    let ran = false;
    const h: Handler = (_req, res) => {
      ran = true;
      res.end("ok");
    };
    h.refuse = () => ({ status: 401, body: { error: "Unauthorized" } });
    r.post("/x", h);
    const res = await request(r.server()).post("/x").send({ big: "payload" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(ran).toBe(false);
  });

  it("lets the request through when refuse returns undefined", async () => {
    const r = new Router();
    const h: Handler = (_req, res) => {
      res.end("ok");
    };
    h.refuse = () => undefined;
    r.post("/x", h);
    const res = await request(r.server()).post("/x").send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });
});
