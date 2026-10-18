import { describe, expect, it } from "vitest";
import {
  cleanPlayerName,
  cleanRoomName,
  cleanSquare,
  cleanTitle,
  DEFAULT_ROOM_CARD,
  parseClientMessage,
  parseServerMessage,
  type ServerMessage,
} from "./protocol.ts";

const parse = (message: unknown) => parseClientMessage(JSON.stringify(message));

const join = (overrides: Record<string, unknown> = {}) => ({
  type: "join",
  v: 1,
  room: "direct-night",
  name: "Leo",
  card: {},
  ...overrides,
});

describe("cleanTitle", () => {
  it("trims and collapses whitespace, newlines included", () => {
    expect(cleanTitle("  Big \n\t Direct  ")).toBe("Big Direct");
  });

  it("strips control and bidi override characters", () => {
    expect(cleanTitle("a\u0000b\u007fc‮d⁦e")).toBe("abcde");
  });

  it("keeps emoji sequences joined by a zero width joiner", () => {
    expect(cleanTitle("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("normalizes to NFC", () => {
    expect(cleanTitle("é")).toBe("é");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(cleanTitle("😀".repeat(80))).toBe("😀".repeat(80));
    expect(cleanTitle("😀".repeat(81))).toBeNull();
  });

  it("measures length after cleaning", () => {
    expect(cleanTitle(` ${"a".repeat(80)} `)).toBe("a".repeat(80));
  });

  it("allows an empty title", () => {
    expect(cleanTitle("   ")).toBe("");
  });

  it("rejects non-strings and lone surrogates", () => {
    expect(cleanTitle(5)).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle("a\uD800b")).toBeNull();
  });
});

describe("cleanSquare", () => {
  it("keeps newlines, at most two in a row", () => {
    expect(cleanSquare("a\nb\n\n\n\nc")).toBe("a\nb\n\nc");
  });

  it("turns CRLF into LF and tabs into spaces", () => {
    expect(cleanSquare("a\r\nb\rc\td")).toBe("a\nb\nc d");
  });

  it("strips other control characters", () => {
    expect(cleanSquare("a\u0007\u001bb")).toBe("ab");
  });

  it("rejects text over 150 code points", () => {
    expect(cleanSquare("a".repeat(150))).toBe("a".repeat(150));
    expect(cleanSquare("a".repeat(151))).toBeNull();
  });
});

describe("cleanPlayerName", () => {
  it("cleans like a title, up to 20 code points", () => {
    expect(cleanPlayerName("  Ana  Maria ")).toBe("Ana Maria");
    expect(cleanPlayerName("a".repeat(21))).toBeNull();
  });

  it("rejects a name that's empty once cleaned", () => {
    expect(cleanPlayerName(" ‮ ")).toBeNull();
    expect(cleanPlayerName("")).toBeNull();
  });
});

describe("cleanRoomName", () => {
  it("lowercases", () => {
    expect(cleanRoomName("Direct-Night-42")).toBe("direct-night-42");
  });

  it("only allows 3 to 32 letters, digits and dashes", () => {
    expect(cleanRoomName("ab")).toBeNull();
    expect(cleanRoomName("a".repeat(33))).toBeNull();
    expect(cleanRoomName("direct night")).toBeNull();
    expect(cleanRoomName("__proto__")).toBeNull();
    expect(cleanRoomName("sala-ção")).toBeNull();
    expect(cleanRoomName(123)).toBeNull();
  });
});

describe("parseClientMessage: join", () => {
  it("fills an empty card with defaults", () => {
    expect(parse(join())).toEqual({
      type: "join",
      v: 1,
      room: "direct-night",
      name: "Leo",
      card: DEFAULT_ROOM_CARD,
    });
  });

  it("reads a full payload and cleans its text", () => {
    const message = parse(
      join({
        room: "Direct-Night",
        card: {
          t: " My  Direct ",
          s: ["Metroid", " Zelda‮ "],
          n: 25,
          th: "xbox",
          m: 5,
          mk: "bean",
          a: 0,
          dg: 1,
          el: 1,
        },
      })
    );
    expect(message).toEqual({
      type: "join",
      v: 1,
      room: "direct-night",
      name: "Leo",
      card: {
        t: "My Direct",
        s: ["Metroid", "Zelda", ...Array<string>(23).fill("")],
        n: 25,
        th: "xbox",
        m: 5,
        mk: "bean",
        a: 0,
        dg: 1,
        el: 1,
      },
    });
  });

  it("leaves the version check to the caller", () => {
    expect(parse(join({ v: 99 }))).toMatchObject({ v: 99 });
    expect(parse(join({ v: "1" }))).toBeNull();
    expect(parse(join({ v: 1.5 }))).toBeNull();
  });

  it.each([
    ["a missing field", { card: undefined }],
    ["a bad room name", { room: "x" }],
    ["an empty player name", { name: " " }],
    ["a card that isn't an object", { card: [] }],
    ["an unknown card key", { card: { v: "p" } }],
    ["too many squares", { card: { s: Array(26).fill("") } }],
    ["a square that isn't a string", { card: { s: [1] } }],
    ["a square too long", { card: { s: ["a".repeat(151)] } }],
    ["a title too long", { card: { t: "a".repeat(81) } }],
    ["a bad square count", { card: { n: 20 } }],
    ["a bad theme id", { card: { th: "<b>" } }],
    ["a marker id that isn't a string", { card: { mk: 1 } }],
    ["a flag that isn't 0 or 1", { card: { a: false } }],
    ["negative marks", { card: { m: -1 } }],
    ["marks over 25 bits", { card: { m: 2 ** 25 } }],
    ["fractional marks", { card: { m: 1.5 } }],
  ])("rejects %s", (_, overrides) => {
    expect(parse(join(overrides))).toBeNull();
  });
});

describe("parseClientMessage: operations", () => {
  it("parses each operation", () => {
    expect(parse({ type: "lock", target: "title" })).toEqual({
      type: "lock",
      target: "title",
    });
    expect(parse({ type: "unlock", target: 24 })).toEqual({
      type: "unlock",
      target: 24,
    });
    expect(parse({ type: "mark", i: 0, on: true })).toEqual({
      type: "mark",
      i: 0,
      on: true,
    });
    expect(parse({ type: "settings", th: "rgb", dg: 1 })).toEqual({
      type: "settings",
      th: "rgb",
      dg: 1,
    });
    expect(parse({ type: "clear" })).toEqual({ type: "clear" });
    expect(parse({ type: "clear-marks" })).toEqual({ type: "clear-marks" });
    expect(parse({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("cleans text by its target", () => {
    expect(parse({ type: "text", target: "title", text: "a\nb" })).toEqual({
      type: "text",
      target: "title",
      text: "a b",
    });
    expect(parse({ type: "text", target: 3, text: "a\nb" })).toEqual({
      type: "text",
      target: 3,
      text: "a\nb",
    });
    expect(
      parse({ type: "text", target: "title", text: "a".repeat(100) })
    ).toBeNull();
  });

  it.each([
    ["a square index of 25", { type: "lock", target: 25 }],
    ["a negative index", { type: "unlock", target: -1 }],
    ["a fractional index", { type: "mark", i: 1.5, on: true }],
    ["an index as a string", { type: "mark", i: "1", on: true }],
    ["an unknown target", { type: "lock", target: "squares" }],
    ["a mark without on", { type: "mark", i: 1 }],
    ["a mark with on as a number", { type: "mark", i: 1, on: 1 }],
    ["text that isn't a string", { type: "text", target: 1, text: 1 }],
    ["empty settings", { type: "settings" }],
    ["an unknown setting", { type: "settings", t: "title" }],
    ["an invalid setting", { type: "settings", n: 9 }],
    ["an extra key", { type: "clear", room: "other" }],
    ["an unknown type", { type: "kick", id: "p1" }],
    ["a missing type", { target: 1 }],
  ])("rejects %s", (_, message) => {
    expect(parse(message)).toBeNull();
  });
});

describe("parseClientMessage: frames", () => {
  it.each([
    ["invalid JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"ping"'],
    ["a number", "1"],
  ])("rejects %s", (_, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("rejects a __proto__ key instead of using it", () => {
    expect(parseClientMessage('{"type":"ping","__proto__":{"x":1}}')).toBeNull();
    expect(
      parseClientMessage(
        '{"type":"join","v":1,"room":"abc","name":"a","card":{"__proto__":{"t":"x"}}}'
      )
    ).toBeNull();
  });
});

describe("parseServerMessage", () => {
  const server = (message: unknown) => parseServerMessage(JSON.stringify(message));

  it("parses each message the server sends", () => {
    const messages: ServerMessage[] = [
      {
        type: "joined",
        you: "p2",
        card: DEFAULT_ROOM_CARD,
        players: [
          { id: "p1", name: "Ana" },
          { id: "p2", name: "Leo" },
        ],
        locks: [{ target: "title", by: "p1" }],
      },
      { type: "player-joined", player: { id: "p3", name: "Mia" } },
      { type: "player-left", id: "p3" },
      { type: "locked", target: 4, by: "p1" },
      { type: "unlocked", target: 4 },
      { type: "text", target: 4, text: "Zelda", by: "p1" },
      { type: "mark", i: 4, on: false },
      { type: "settings", n: 25 },
      { type: "cleared", squares: [0, 1, 24] },
      { type: "cleared", squares: [] },
      { type: "error", code: "room-full" },
      { type: "pong" },
    ];
    for (const message of messages) expect(server(message)).toEqual(message);
  });

  it("cleans text from the server too", () => {
    expect(
      server({ type: "text", target: "title", text: "a‮\nb", by: "p1" })
    ).toMatchObject({ text: "a b" });
    expect(
      server({ type: "player-joined", player: { id: "p1", name: " Ana\u0000 " } })
    ).toEqual({ type: "player-joined", player: { id: "p1", name: "Ana" } });
  });

  it.each([
    ["a bad player id", { type: "player-left", id: "admin" }],
    ["a player id of p0", { type: "player-left", id: "p0" }],
    ["a locked without by", { type: "locked", target: 1 }],
    ["an unlocked with by", { type: "unlocked", target: 1, by: "p1" }],
    ["text over the limit", { type: "text", target: 1, text: "a".repeat(151), by: "p1" }],
    ["a square index in cleared out of range", { type: "cleared", squares: [25] }],
    ["too many cleared squares", { type: "cleared", squares: Array(26).fill(0) }],
    ["an unknown error code", { type: "error", code: "pwned" }],
    ["an extra key", { type: "pong", html: "<b>" }],
    ["a joined with an invalid card", { type: "joined", you: "p1", card: { m: -1 }, players: [], locks: [] }],
    ["a joined with an invalid player", { type: "joined", you: "p1", card: {}, players: [{ id: "p1" }], locks: [] }],
    ["a joined with too many players", {
      type: "joined",
      you: "p1",
      card: {},
      players: Array.from({ length: 101 }, (_, i) => ({ id: `p${i + 1}`, name: "x" })),
      locks: [],
    }],
    ["a client-only type", { type: "clear" }],
  ])("rejects %s", (_, message) => {
    expect(server(message)).toBeNull();
  });
});
