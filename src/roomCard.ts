import type { RoomCard, Settings, Target } from "./protocol.ts";

// Changes to a room's card. Each returns a new card, and takes values that
// protocol.ts has already validated and cleaned

export const getText = (card: RoomCard, target: Target) =>
  target === "title" ? card.t : card.s[target];

export const setText = (
  card: RoomCard,
  target: Target,
  text: string
): RoomCard =>
  target === "title"
    ? { ...card, t: text }
    : { ...card, s: card.s.with(target, text) };

export const setMark = (card: RoomCard, i: number, on: boolean): RoomCard => ({
  ...card,
  m: on ? card.m | (1 << i) : card.m & ~(1 << i),
});

export const applySettings = (card: RoomCard, settings: Settings): RoomCard => ({
  ...card,
  ...settings,
});

// Empties the given squares and turns every mark off, like the frontend's
// Clear (with no squares, its Clear marks)
export const clearSquares = (card: RoomCard, squares: number[]): RoomCard => ({
  ...card,
  s: card.s.map((text, i) => (squares.includes(i) ? "" : text)),
  m: 0,
});
