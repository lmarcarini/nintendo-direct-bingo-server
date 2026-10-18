import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "./config.ts";
import { CLOSE_HANDSHAKE_TIMEOUT, CLOSE_VERSION } from "./connection.ts";
import type { ServerMessage } from "./protocol.ts";
import { CLOSE_RESTART, startServer, type RunningServer } from "./server.ts";

const ORIGIN = "http://bingo.test";

const CONFIG: Config = {
  port: 0,
  allowedOrigins: [ORIGIN],
  maxRooms: 5,
  maxPlayersPerRoom: 8,
  maxConnections: 4,
  maxConnectionsPerIp: 3,
  maxMessageBytes: 1024,
  handshakeTimeoutMs: 300,
  roomGraceMs: 60_000,
  lockTimeoutMs: 30_000,
  rateBurst: 5,
  ratePerSec: 1,
};

let server: RunningServer;
let url: string;
const clients: WebSocket[] = [];

beforeEach(async () => {
  server = await startServer(CONFIG, () => {});
  url = `ws://localhost:${server.port}`;
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await server.close();
});

// An open socket with its incoming messages as a queue
const connect = async (origin = ORIGIN, headers: Record<string, string> = {}) => {
  const ws = new WebSocket(url, { origin, headers });
  clients.push(ws);
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else inbox.push(message);
  });
  await once(ws, "open");
  return {
    ws,
    send: (message: unknown) =>
      ws.send(typeof message === "string" ? message : JSON.stringify(message)),
    next: () =>
      new Promise<ServerMessage>((resolve) => {
        const message = inbox.shift();
        if (message) resolve(message);
        else waiting.push(resolve);
      }),
    closed: async () => {
      const [code] = await once(ws, "close");
      return code as number;
    },
  };
};

const joinRoom = async (name: string, card = {}) => {
  const client = await connect();
  client.send({ type: "join", v: 1, room: "direct", name, card });
  const joined = await client.next();
  expect(joined.type).toBe("joined");
  return { ...client, joined };
};

describe("room server", () => {
  it("answers the health check", async () => {
    const response = await fetch(`http://localhost:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect((await fetch(`http://localhost:${server.port}/`)).status).toBe(404);
  });

  it("creates a room and gives the next player its card", async () => {
    const ana = await joinRoom("Ana", { t: "Direct", s: ["Metroid"] });
    const leo = await joinRoom("Leo", { t: "Ignored" });
    expect(leo.joined).toMatchObject({
      you: "p2",
      card: { t: "Direct" },
      players: [
        { id: "p1", name: "Ana" },
        { id: "p2", name: "Leo" },
      ],
    });
    expect(await ana.next()).toEqual({
      type: "player-joined",
      player: { id: "p2", name: "Leo" },
    });
  });

  it("syncs locks, text and marks", async () => {
    const ana = await joinRoom("Ana");
    const leo = await joinRoom("Leo");
    await ana.next(); // player-joined

    ana.send({ type: "lock", target: 0 });
    expect(await ana.next()).toEqual({ type: "locked", target: 0, by: "p1" });
    expect(await leo.next()).toEqual({ type: "locked", target: 0, by: "p1" });

    leo.send({ type: "lock", target: 0 });
    expect(await leo.next()).toEqual({ type: "error", code: "locked" });

    ana.send({ type: "text", target: 0, text: " Zelda‮ " });
    expect(await leo.next()).toEqual({ type: "text", target: 0, text: "Zelda", by: "p1" });

    leo.send({ type: "mark", i: 0, on: true });
    expect(await leo.next()).toEqual({ type: "mark", i: 0, on: true });
    // The text never came back to Ana: her next message is the mark
    expect(await ana.next()).toEqual({ type: "mark", i: 0, on: true });
  });

  it("tells the others when someone disconnects, releasing their lock", async () => {
    const ana = await joinRoom("Ana");
    const leo = await joinRoom("Leo");
    await ana.next();
    ana.send({ type: "lock", target: "title" });
    await leo.next();
    ana.ws.close();
    expect(await leo.next()).toEqual({ type: "unlocked", target: "title" });
    expect(await leo.next()).toEqual({ type: "player-left", id: "p1" });
  });

  it("answers invalid messages with an error and keeps the connection", async () => {
    const client = await connect();
    client.send("not json");
    expect(await client.next()).toEqual({ type: "error", code: "invalid" });
    client.send({ type: "mark", i: 0, on: true });
    expect(await client.next()).toEqual({ type: "error", code: "not-joined" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  });

  it("refuses a second join on the same connection", async () => {
    const ana = await joinRoom("Ana");
    ana.send({ type: "join", v: 1, room: "other", name: "Ana", card: {} });
    expect(await ana.next()).toEqual({ type: "error", code: "invalid" });
  });

  it("refuses other origins and paths", async () => {
    for (const ws of [
      new WebSocket(url, { origin: "https://evil.test" }),
      new WebSocket(url),
      new WebSocket(`${url}/rooms`, { origin: ORIGIN }),
    ]) {
      const [error] = await once(ws, "error");
      expect((error as Error).message).toMatch(/40[34]/);
    }
  });

  it("caps connections per IP", async () => {
    await Promise.all([connect(), connect(), connect()]);
    const [error] = await once(new WebSocket(url, { origin: ORIGIN }), "error");
    expect((error as Error).message).toMatch(/503/);
  });

  it("counts IPs by the last X-Forwarded-For entry, which Render's proxy adds", async () => {
    // Clients can put anything first; Render appends the address it saw
    const via = (i: number) => ({ "X-Forwarded-For": `203.0.113.${i}, 198.51.100.1` });
    await Promise.all([connect(ORIGIN, via(1)), connect(ORIGIN, via(2)), connect(ORIGIN, via(3))]);
    const [error] = await once(
      new WebSocket(url, { origin: ORIGIN, headers: via(4) }),
      "error"
    );
    expect((error as Error).message).toMatch(/503/);
    // A different real address still gets in
    await connect(ORIGIN, { "X-Forwarded-For": "198.51.100.2" });
  });

  it("closes a connection that doesn't join in time", async () => {
    const client = await connect();
    expect(await client.closed()).toBe(CLOSE_HANDSHAKE_TIMEOUT);
  });

  it("closes on a protocol version mismatch", async () => {
    const client = await connect();
    client.send({ type: "join", v: 99, room: "direct", name: "Ana", card: {} });
    expect(await client.closed()).toBe(CLOSE_VERSION);
  });

  it("closes on an oversized message", async () => {
    const client = await connect();
    client.send("x".repeat(2048));
    expect(await client.closed()).toBe(1009);
  });

  it("closes on binary frames", async () => {
    const client = await connect();
    client.ws.send(Buffer.from("{}"));
    expect(await client.closed()).toBe(1003);
  });

  it("rate-limits, then hangs up on a client that keeps going", async () => {
    const client = await connect();
    for (let i = 0; i < 5; i++) client.send({ type: "ping" });
    for (let i = 0; i < 5; i++) expect(await client.next()).toEqual({ type: "pong" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "error", code: "rate-limited" });
    for (let i = 0; i < 4; i++) client.send({ type: "ping" });
    expect(await client.closed()).toBe(1008);
  });

  it("tells clients to reconnect when it shuts down", async () => {
    const ana = await joinRoom("Ana");
    const closed = ana.closed();
    await server.close();
    expect(await closed).toBe(CLOSE_RESTART);
    server = await startServer(CONFIG, () => {}); // for afterEach
  });
});
