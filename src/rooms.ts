import type {
  ErrorCode,
  PlayerId,
  RoomCard,
  ServerMessage,
  Settings,
  Target,
} from "./protocol.ts";
import {
  applySettings,
  clearSquares,
  getText,
  setMark,
  setText,
} from "./roomCard.ts";

// The rooms, all in memory. Knows nothing about sockets: a player is a
// `send` function, and time comes from `now`, so it's tested without either

export type Send = (message: ServerMessage) => void;

export type RoomLimits = {
  maxRooms: number;
  maxPlayersPerRoom: number;
  roomGraceMs: number;
  lockTimeoutMs: number;
};

type Player = { id: PlayerId; name: string; send: Send };
type Lock = { by: PlayerId; at: number };
type Room = {
  card: RoomCard;
  players: Map<PlayerId, Player>;
  locks: Map<Target, Lock>;
  nextId: number;
  emptySince?: number;
};

// What a player who joined can do. A refused operation returns its error
// code and changes nothing. After `leave`, every call does nothing
export type Member = {
  lock: (target: Target) => ErrorCode | undefined;
  unlock: (target: Target) => void;
  text: (target: Target, text: string) => ErrorCode | undefined;
  mark: (i: number, on: boolean) => void;
  settings: (settings: Settings) => void;
  clear: () => void;
  clearMarks: () => void;
  leave: () => void;
};

export type Rooms = ReturnType<typeof createRooms>;

export const createRooms = (
  limits: RoomLimits,
  now: () => number = Date.now,
  log: (event: string) => void = () => {}
) => {
  // A Map, never an object: room names come from players
  const rooms = new Map<string, Room>();

  const broadcast = (room: Room, message: ServerMessage, except?: PlayerId) => {
    for (const player of room.players.values())
      if (player.id !== except) player.send(message);
  };

  const isExpired = (lock: Lock) => now() - lock.at >= limits.lockTimeoutMs;

  const release = (room: Room, target: Target) => {
    room.locks.delete(target);
    broadcast(room, { type: "unlocked", target });
  };

  const releaseAll = (room: Room, id: PlayerId) => {
    for (const [target, lock] of room.locks)
      if (lock.by === id) release(room, target);
  };

  // Joins the room, creating it from `card` if it doesn't exist. Sends
  // `joined` to the new player and `player-joined` to the others
  const join = (
    roomName: string,
    name: string,
    card: RoomCard,
    send: Send
  ): Member | ErrorCode => {
    let room = rooms.get(roomName);
    if (!room) {
      if (rooms.size >= limits.maxRooms) return "rooms-full";
      room = { card, players: new Map(), locks: new Map(), nextId: 0 };
      rooms.set(roomName, room);
      log(`room created (${rooms.size} rooms)`);
    } else if (room.players.size >= limits.maxPlayersPerRoom) {
      return "room-full";
    }

    const id = `p${++room.nextId}`;
    room.players.set(id, { id, name, send });
    room.emptySince = undefined;
    send({
      type: "joined",
      you: id,
      card: room.card,
      players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })),
      locks: [...room.locks].map(([target, lock]) => ({ target, by: lock.by })),
    });
    broadcast(room, { type: "player-joined", player: { id, name } }, id);
    return member(room, id);
  };

  const member = (room: Room, id: PlayerId): Member => {
    let left = false;

    return {
      lock(target) {
        if (left) return;
        const current = room.locks.get(target);
        if (current?.by === id) {
          current.at = now();
          return;
        }
        if (current && !isExpired(current)) return "locked";
        // One lock per player: focusing another square lets go of the last
        releaseAll(room, id);
        room.locks.set(target, { by: id, at: now() });
        broadcast(room, { type: "locked", target, by: id });
      },

      unlock(target) {
        if (left || room.locks.get(target)?.by !== id) return;
        release(room, target);
      },

      text(target, text) {
        if (left) return;
        const lock = room.locks.get(target);
        if (lock?.by !== id) return "locked";
        lock.at = now();
        if (getText(room.card, target) === text) return;
        room.card = setText(room.card, target, text);
        // Not back to the sender: it would rewind the cursor of who's typing
        broadcast(room, { type: "text", target, text, by: id }, id);
      },

      mark(i, on) {
        if (left) return;
        room.card = setMark(room.card, i, on);
        broadcast(room, { type: "mark", i, on });
      },

      settings(settings) {
        if (left) return;
        room.card = applySettings(room.card, settings);
        broadcast(room, { type: "settings", ...settings });
      },

      // Squares someone else is editing keep their text
      clear() {
        if (left) return;
        const squares = room.card.s
          .map((_, i) => i)
          .filter((i) => (room.locks.get(i)?.by ?? id) === id);
        room.card = clearSquares(room.card, squares);
        broadcast(room, { type: "cleared", squares });
      },

      clearMarks() {
        if (left) return;
        room.card = clearSquares(room.card, []);
        broadcast(room, { type: "cleared", squares: [] });
      },

      leave() {
        if (left) return;
        left = true;
        room.players.delete(id);
        releaseAll(room, id);
        broadcast(room, { type: "player-left", id });
        if (!room.players.size) room.emptySince = now();
      },
    };
  };

  // Run periodically: lets go of stale locks and frees rooms that have been
  // empty for the grace period
  const sweep = () => {
    for (const [name, room] of rooms) {
      if (room.emptySince !== undefined) {
        if (now() - room.emptySince >= limits.roomGraceMs) {
          rooms.delete(name);
          log(`room freed (${rooms.size} rooms)`);
        }
        continue;
      }
      for (const [target, lock] of room.locks)
        if (isExpired(lock)) release(room, target);
    }
  };

  const stats = () => ({
    rooms: rooms.size,
    players: [...rooms.values()].reduce((sum, r) => sum + r.players.size, 0),
  });

  return { join, sweep, stats };
};
