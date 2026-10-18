import type { WebSocket } from "ws";
import {
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "./protocol.ts";
import { createRateLimiter } from "./rateLimit.ts";
import type { Member, Rooms } from "./rooms.ts";

export type ConnectionOptions = {
  handshakeTimeoutMs: number;
  rateBurst: number;
  ratePerSec: number;
};

// Close codes the frontend acts on: a version mismatch means reload, the
// others mean reconnect (see the CLAUDE.md protocol section)
export const CLOSE_VERSION = 4000;
export const CLOSE_HANDSHAKE_TIMEOUT = 4001;

// One socket, from its first message to its close: rate limit, parse,
// then the join handshake or an operation on the player's room
export const handleConnection = (
  socket: WebSocket,
  rooms: Rooms,
  options: ConnectionOptions,
  log: (event: string) => void
) => {
  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const sendError = (code: ErrorCode) => send({ type: "error", code });

  let member: Member | undefined;
  const allow = createRateLimiter(options.rateBurst, options.ratePerSec);
  let dropped = 0; // in a row

  const handshake = setTimeout(() => {
    if (!member) socket.close(CLOSE_HANDSHAKE_TIMEOUT, "join timeout");
  }, options.handshakeTimeoutMs);

  const join = (message: Extract<ClientMessage, { type: "join" }>) => {
    if (message.v !== PROTOCOL_VERSION) {
      socket.close(CLOSE_VERSION, "protocol version");
      return;
    }
    const result = rooms.join(message.room, message.name, message.card, send);
    if (typeof result === "string") return sendError(result);
    member = result;
    clearTimeout(handshake);
  };

  type Operation = Exclude<ClientMessage, { type: "join" | "ping" }>;

  const apply = (member: Member, message: Operation) => {
    switch (message.type) {
      case "lock":
        return member.lock(message.target);
      case "unlock":
        return member.unlock(message.target);
      case "text":
        return member.text(message.target, message.text);
      case "mark":
        return member.mark(message.i, message.on);
      case "settings": {
        const { type, ...settings } = message;
        return member.settings(settings);
      }
      case "clear":
        return member.clear();
      case "clear-marks":
        return member.clearMarks();
    }
  };

  socket.on("message", (data, isBinary) => {
    if (!allow()) {
      // Say so once, and hang up on a client that keeps going
      if (dropped++ === 0) sendError("rate-limited");
      if (dropped >= options.rateBurst) socket.close(1008, "rate limit");
      return;
    }
    dropped = 0;
    if (isBinary) {
      socket.close(1003, "text frames only");
      return;
    }

    const message = parseClientMessage(String(data));
    if (!message) return sendError("invalid");
    try {
      if (message.type === "ping") send({ type: "pong" });
      else if (message.type === "join") {
        if (member) sendError("invalid");
        else join(message);
      } else if (!member) sendError("not-joined");
      else {
        const code = apply(member, message);
        if (code) sendError(code);
      }
    } catch (error) {
      // A bug here shouldn't take the server down. Log where, not what
      log(`handler error on ${message.type}: ${(error as Error).name}`);
      sendError("invalid");
    }
  });

  socket.on("close", () => {
    clearTimeout(handshake);
    member?.leave();
  });

  socket.on("error", (error) => log(`socket error: ${error.name}`));
};
