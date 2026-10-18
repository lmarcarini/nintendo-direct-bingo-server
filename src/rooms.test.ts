import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROOM_CARD, type ServerMessage } from "./protocol.ts";
import { createRooms, type Member } from "./rooms.ts";

const LIMITS = {
  maxRooms: 2,
  maxPlayersPerRoom: 3,
  roomGraceMs: 60_000,
  lockTimeoutMs: 30_000,
};

let time: number;
let rooms: ReturnType<typeof createRooms>;

beforeEach(() => {
  time = 0;
  rooms = createRooms(LIMITS, () => time);
});

// Joins and returns the member with the messages it receives
const join = (name: string, room = "room", card = DEFAULT_ROOM_CARD) => {
  const inbox: ServerMessage[] = [];
  const result = rooms.join(room, name, card, (message) => inbox.push(message));
  if (typeof result === "string") throw new Error(result);
  return { member: result as Member, inbox };
};

// The room's card, as a player joining now would get it
const roomCard = (room = "room") => {
  const joined = join("Viewer", room).inbox[0];
  if (joined.type !== "joined") throw new Error(joined.type);
  return joined.card;
};

describe("join", () => {
  it("creates the room from the first player's card", () => {
    const card = { ...DEFAULT_ROOM_CARD, t: "Mine" };
    const { inbox } = join("Ana", "room", card);
    expect(inbox).toEqual([
      { type: "joined", you: "p1", card, players: [{ id: "p1", name: "Ana" }], locks: [] },
    ]);
  });

  it("gives later players the room's card, not theirs", () => {
    const ana = join("Ana", "room", { ...DEFAULT_ROOM_CARD, t: "Room" });
    ana.member.lock(3);
    const leo = join("Leo", "room", { ...DEFAULT_ROOM_CARD, t: "Other" });
    expect(leo.inbox[0]).toEqual({
      type: "joined",
      you: "p2",
      card: { ...DEFAULT_ROOM_CARD, t: "Room" },
      players: [
        { id: "p1", name: "Ana" },
        { id: "p2", name: "Leo" },
      ],
      locks: [{ target: 3, by: "p1" }],
    });
    expect(ana.inbox.at(-1)).toEqual({
      type: "player-joined",
      player: { id: "p2", name: "Leo" },
    });
  });

  it("allows two players with the same name", () => {
    join("Leo");
    expect(join("Leo").inbox[0]).toMatchObject({ you: "p2" });
  });

  it("caps players per room and rooms in total", () => {
    join("a");
    join("b");
    join("c");
    const send = () => {};
    expect(rooms.join("room", "d", DEFAULT_ROOM_CARD, send)).toBe("room-full");
    join("e", "second");
    expect(rooms.join("third", "f", DEFAULT_ROOM_CARD, send)).toBe("rooms-full");
  });
});

describe("locks", () => {
  it("goes to the first player who asks", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    expect(ana.member.lock("title")).toBeUndefined();
    expect(leo.member.lock("title")).toBe("locked");
    expect(leo.inbox.at(-1)).toEqual({ type: "locked", target: "title", by: "p1" });
  });

  it("is one per player: taking another releases the last", () => {
    const ana = join("Ana");
    ana.member.lock(1);
    ana.member.lock(2);
    expect(ana.inbox.slice(-2)).toEqual([
      { type: "unlocked", target: 1 },
      { type: "locked", target: 2, by: "p1" },
    ]);
  });

  it("can only be released by its holder", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.lock(1);
    leo.member.unlock(1);
    expect(leo.member.lock(1)).toBe("locked");
    ana.member.unlock(1);
    expect(leo.member.lock(1)).toBeUndefined();
  });

  it("is released when its holder leaves", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.lock(1);
    ana.member.leave();
    expect(leo.inbox.slice(-2)).toEqual([
      { type: "unlocked", target: 1 },
      { type: "player-left", id: "p1" },
    ]);
  });

  it("expires without activity, but typing keeps it", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.lock(1);
    time = 20_000;
    ana.member.text(1, "a");
    time = 40_000;
    rooms.sweep();
    expect(leo.member.lock(1)).toBe("locked");
    time = 50_000;
    rooms.sweep();
    expect(leo.inbox.at(-1)).toEqual({ type: "unlocked", target: 1 });
    expect(leo.member.lock(1)).toBeUndefined();
  });

  it("can be taken over once expired, even before a sweep", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.lock(1);
    time = 30_000;
    expect(leo.member.lock(1)).toBeUndefined();
    expect(ana.member.text(1, "late")).toBe("locked");
  });
});

describe("operations", () => {
  it("only takes text from the lock holder, and not back to them", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    expect(ana.member.text(0, "Zelda")).toBe("locked");
    ana.member.lock(0);
    const sent = ana.inbox.length;
    expect(ana.member.text(0, "Zelda")).toBeUndefined();
    expect(ana.inbox.length).toBe(sent);
    expect(leo.inbox.at(-1)).toEqual({ type: "text", target: 0, text: "Zelda", by: "p1" });
    expect(roomCard().s[0]).toBe("Zelda");
  });

  it("sends marks and settings to everyone, sender included", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.mark(4, true);
    leo.member.settings({ th: "xbox", dg: 1 });
    for (const { inbox } of [ana, leo])
      expect(inbox.slice(-2)).toEqual([
        { type: "mark", i: 4, on: true },
        { type: "settings", th: "xbox", dg: 1 },
      ]);
    expect(roomCard()).toMatchObject({ m: 16, th: "xbox", dg: 1 });
  });

  it("converges when two players mark the same square at once", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.mark(0, true);
    leo.member.mark(0, false);
    const last = { type: "mark", i: 0, on: false };
    expect(ana.inbox.at(-1)).toEqual(last);
    expect(leo.inbox.at(-1)).toEqual(last);
  });

  it("clears every square but those someone else is editing", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    leo.member.lock(2);
    leo.member.text(2, "Mine");
    ana.member.lock(0);
    ana.member.mark(1, true);
    ana.member.clear();
    const message = ana.inbox.at(-1);
    expect(message).toMatchObject({ type: "cleared" });
    const squares = (message as { squares: number[] }).squares;
    expect(squares).toContain(0);
    expect(squares).not.toContain(2);
    expect(squares).toHaveLength(24);
    const card = roomCard();
    expect(card.m).toBe(0);
    expect(card.s.slice(0, 3)).toEqual(["", "", "Mine"]);
  });

  it("clears only the marks", () => {
    const ana = join("Ana");
    ana.member.lock(0);
    ana.member.text(0, "Zelda");
    ana.member.mark(0, true);
    ana.member.clearMarks();
    expect(ana.inbox.at(-1)).toEqual({ type: "cleared", squares: [] });
    const card = roomCard();
    expect(card.m).toBe(0);
    expect(card.s[0]).toBe("Zelda");
  });

  it("does nothing after leaving", () => {
    const ana = join("Ana");
    const leo = join("Leo");
    ana.member.leave();
    const sent = leo.inbox.length;
    ana.member.mark(0, true);
    ana.member.leave();
    expect(ana.member.lock(0)).toBeUndefined();
    expect(leo.inbox.length).toBe(sent);
  });
});

describe("freeing rooms", () => {
  it("frees an empty room after the grace period", () => {
    join("Ana", "room", { ...DEFAULT_ROOM_CARD, t: "Old" }).member.leave();
    expect(rooms.stats()).toEqual({ rooms: 1, players: 0 });
    time = 59_999;
    rooms.sweep();
    expect(rooms.stats().rooms).toBe(1);
    time = 60_000;
    rooms.sweep();
    expect(rooms.stats().rooms).toBe(0);
    const card = { ...DEFAULT_ROOM_CARD, t: "New" };
    expect(join("Ana", "room", card).inbox[0]).toMatchObject({ card });
  });

  it("keeps a room someone rejoins within the grace period", () => {
    join("Ana", "room", { ...DEFAULT_ROOM_CARD, t: "Kept" }).member.leave();
    time = 30_000;
    const { member, inbox } = join("Ana");
    expect(inbox[0]).toMatchObject({ card: { t: "Kept" } });
    time = 100_000;
    rooms.sweep();
    expect(rooms.stats()).toEqual({ rooms: 1, players: 1 });
    member.leave();
  });
});
