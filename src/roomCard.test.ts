import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_CARD } from "./protocol.ts";
import { clearSquares, setMark, setText } from "./roomCard.ts";

describe("roomCard", () => {
  it("sets the title or one square, leaving the card it was given alone", () => {
    const card = setText(DEFAULT_ROOM_CARD, 2, "Zelda");
    expect(card.s[2]).toBe("Zelda");
    expect(setText(card, "title", "Direct").t).toBe("Direct");
    expect(DEFAULT_ROOM_CARD.s[2]).toBe("");
  });

  it("sets and unsets marks, up to the last square", () => {
    let card = setMark(DEFAULT_ROOM_CARD, 24, true);
    card = setMark(card, 0, true);
    expect(card.m).toBe(2 ** 24 + 1);
    expect(setMark(card, 24, false).m).toBe(1);
    expect(setMark(card, 0, true).m).toBe(card.m);
  });

  it("clears the given squares and every mark", () => {
    const card = { ...DEFAULT_ROOM_CARD, s: DEFAULT_ROOM_CARD.s.map(() => "x"), m: 7 };
    const cleared = clearSquares(card, [0, 2]);
    expect(cleared.s.slice(0, 3)).toEqual(["", "x", ""]);
    expect(cleared.m).toBe(0);
  });
});
