import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.ts";
import { handleConnection } from "./connection.ts";
import { createRooms } from "./rooms.ts";

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 5_000;
const SHUTDOWN_WAIT_MS = 1_000;

export const CLOSE_RESTART = 1012;

export type RunningServer = { port: number; close: () => Promise<void> };

// Render's proxy puts the client's address first. It can be spoofed when
// reaching the server some other way, so the per-IP cap is only a courtesy:
// MAX_CONNECTIONS is the limit that holds
const clientIp = (req: IncomingMessage) => {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim();
  return first || req.socket.remoteAddress || "unknown";
};

const refuse = (socket: Duplex, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

// An HTTP server for the health check, upgrading allowed requests on "/" to
// WebSockets. Resolves once it's listening
export const startServer = (
  config: Config,
  log: (event: string) => void = console.log
): Promise<RunningServer> => {
  const rooms = createRooms(config, Date.now, log);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxMessageBytes,
    perMessageDeflate: false,
  });
  const connectionsPerIp = new Map<string, number>();
  const alive = new WeakSet<WebSocket>();

  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz")
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    else res.writeHead(404).end();
  });

  http.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const ip = clientIp(req);
    const fromIp = connectionsPerIp.get(ip) ?? 0;
    if (req.url !== "/") return refuse(socket, "404 Not Found");
    if (!config.allowedOrigins.includes(req.headers.origin ?? "")) {
      log("refused: origin");
      return refuse(socket, "403 Forbidden");
    }
    if (
      wss.clients.size >= config.maxConnections ||
      fromIp >= config.maxConnectionsPerIp
    ) {
      log("refused: connection cap");
      return refuse(socket, "503 Service Unavailable");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
      ws.once("close", () => {
        const left = (connectionsPerIp.get(ip) ?? 1) - 1;
        if (left) connectionsPerIp.set(ip, left);
        else connectionsPerIp.delete(ip);
      });
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      handleConnection(ws, rooms, config, log);
    });
  });

  // Drops sockets that didn't answer the last ping (a phone that went to
  // sleep, a network that vanished), which also lets go of their locks
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const sweep = setInterval(rooms.sweep, SWEEP_MS);

  // Tells every client to reconnect, waits briefly for them to hang up,
  // then stops
  const close = async () => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    const closed = [...wss.clients].map(
      (ws) => new Promise((resolve) => ws.once("close", resolve))
    );
    for (const ws of wss.clients) ws.close(CLOSE_RESTART, "server restart");
    await Promise.race([
      Promise.all(closed),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
    ]);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  };

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, () => {
      const { port } = http.address() as AddressInfo;
      resolve({ port, close });
    });
  });
};
