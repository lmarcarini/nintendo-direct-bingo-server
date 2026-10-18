// The messages between the frontend and the room server, and the checks
// every incoming message goes through. The frontend keeps a copy of this
// file: change both together, and bump PROTOCOL_VERSION on any change that
// breaks the other side

export const PROTOCOL_VERSION = 1;

export const MAX_SQUARES = 25;
export const MAX_TITLE_LENGTH = 80; // in code points, after cleaning
export const MAX_SQUARE_LENGTH = 150;
export const MAX_PLAYER_NAME_LENGTH = 20;

const ROOM_NAME = /^[a-z0-9-]{3,32}$/;
// Theme and marker ids are only checked for shape: the frontend maps ids it
// doesn't know to its defaults, so a new theme doesn't need a server deploy
const STYLE_ID = /^[a-z0-9-]{1,32}$/;
const ALL_MARKS = 2 ** MAX_SQUARES - 1;

// The frontend's card payload (see its card/payload.ts) with every field
// present. `t` is "" for the default title; view mode is per player and
// isn't part of it
export type RoomCard = {
  t: string; // title
  s: string[]; // square text, always MAX_SQUARES long
  n: 16 | 25; // squares in use
  th: string; // theme id
  m: number; // marks, bit i = square i
  mk: string; // marker id
  a: 0 | 1; // celebrations
  dg: 0 | 1; // diagonals count as lines
  el: 0 | 1; // celebrate every line
};

export const DEFAULT_ROOM_CARD: RoomCard = {
  t: "",
  s: Array<string>(MAX_SQUARES).fill(""),
  n: 16,
  th: "nintendo",
  m: 0,
  mk: "none",
  a: 1,
  dg: 0,
  el: 0,
};

export type Settings = Partial<Pick<RoomCard, "n" | "th" | "mk" | "a" | "dg" | "el">>;
export type Target = "title" | number; // a square index
export type PlayerId = string;
export type PlayerInfo = { id: PlayerId; name: string };
export type LockInfo = { target: Target; by: PlayerId };

export type ClientMessage =
  | { type: "join"; v: number; room: string; name: string; card: RoomCard }
  | { type: "lock" | "unlock"; target: Target }
  | { type: "text"; target: Target; text: string }
  | { type: "mark"; i: number; on: boolean }
  | ({ type: "settings" } & Settings)
  | { type: "clear" | "clear-marks" | "ping" };

export type ErrorCode =
  | "invalid"
  | "version"
  | "not-joined"
  | "rooms-full"
  | "room-full"
  | "locked"
  | "rate-limited";

export type ServerMessage =
  | {
      type: "joined";
      you: PlayerId;
      card: RoomCard;
      players: PlayerInfo[];
      locks: LockInfo[];
    }
  | { type: "player-joined"; player: PlayerInfo }
  | { type: "player-left"; id: PlayerId }
  | { type: "locked"; target: Target; by: PlayerId }
  | { type: "unlocked"; target: Target }
  | { type: "text"; target: Target; text: string; by: PlayerId }
  | { type: "mark"; i: number; on: boolean }
  | ({ type: "settings" } & Settings)
  | { type: "cleared"; squares: number[] } // those squares emptied, all marks off
  | { type: "error"; code: ErrorCode }
  | { type: "pong" };

// Text

// Bidi embedding, override and isolate controls can make text display as
// something other than what it is. Other format characters stay: the zero
// width joiner holds emoji sequences together
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

// Normalizes text and returns it, or null if it's not a string, isn't
// well-formed UTF-16 or is too long once cleaned
const cleanText = (
  value: unknown,
  maxLength: number,
  multiline: boolean
): string | null => {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  let text = value.normalize("NFC").replace(BIDI_CONTROLS, "");
  text = multiline
    ? text
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, " ")
        .replace(/[\p{Cc}--[\n]]/gv, "")
        .replace(/\n{3,}/g, "\n\n")
    : text
        .replace(/\s+/g, " ")
        .replace(/\p{Cc}/gu, "")
        .replace(/ {2,}/g, " ");
  text = text.trim();
  return [...text].length <= maxLength ? text : null;
};

export const cleanTitle = (value: unknown) =>
  cleanText(value, MAX_TITLE_LENGTH, false);

export const cleanSquare = (value: unknown) =>
  cleanText(value, MAX_SQUARE_LENGTH, true);

export const cleanPlayerName = (value: unknown) =>
  cleanText(value, MAX_PLAYER_NAME_LENGTH, false) || null;

export const cleanRoomName = (value: unknown) => {
  if (typeof value !== "string") return null;
  const room = value.toLowerCase();
  return ROOM_NAME.test(room) ? room : null;
};

// Messages

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// All required keys present, and no key that isn't required or optional
const hasKeys = (
  fields: Fields,
  required: readonly string[],
  optional: readonly string[] = []
) =>
  required.every((key) => Object.hasOwn(fields, key)) &&
  Object.keys(fields).every(
    (key) => required.includes(key) || optional.includes(key)
  );

const isIndex = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_SQUARES;

const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

const parseTarget = (value: unknown): Target | null =>
  value === "title" || isIndex(value) ? value : null;

const SETTING_KEYS = ["n", "th", "mk", "a", "dg", "el"] as const;
const CARD_KEYS = ["t", "s", "m", ...SETTING_KEYS] as const;

// Reads the setting keys present in `fields`, ignoring other keys
const parseSettings = (fields: Fields): Settings | null => {
  const settings: Settings = {};
  if (Object.hasOwn(fields, "n")) {
    if (fields.n !== 16 && fields.n !== 25) return null;
    settings.n = fields.n;
  }
  for (const key of ["th", "mk"] as const) {
    if (!Object.hasOwn(fields, key)) continue;
    const id = fields[key];
    if (typeof id !== "string" || !STYLE_ID.test(id)) return null;
    settings[key] = id;
  }
  for (const key of ["a", "dg", "el"] as const) {
    if (!Object.hasOwn(fields, key)) continue;
    const flag = fields[key];
    if (!isFlag(flag)) return null;
    settings[key] = flag;
  }
  return settings;
};

// The card sent on join: the frontend's payload, where a missing field
// holds its default
const parseCard = (value: unknown): RoomCard | null => {
  if (!isObject(value) || !hasKeys(value, [], CARD_KEYS)) return null;
  const settings = parseSettings(value);
  if (!settings) return null;

  let t = DEFAULT_ROOM_CARD.t;
  if (Object.hasOwn(value, "t")) {
    const title = cleanTitle(value.t);
    if (title === null) return null;
    t = title;
  }

  const s = [...DEFAULT_ROOM_CARD.s];
  if (Object.hasOwn(value, "s")) {
    if (!Array.isArray(value.s) || value.s.length > MAX_SQUARES) return null;
    for (const [i, raw] of value.s.entries()) {
      const square = cleanSquare(raw);
      if (square === null) return null;
      s[i] = square;
    }
  }

  let m = DEFAULT_ROOM_CARD.m;
  if (Object.hasOwn(value, "m")) {
    if (!Number.isInteger(value.m)) return null;
    m = value.m as number;
    if (m < 0 || m > ALL_MARKS) return null;
  }

  return { ...DEFAULT_ROOM_CARD, ...settings, t, s, m };
};

// Parses one frame from a client. Anything that isn't exactly a valid
// message is null; the protocol version is checked by the caller, so it can
// answer a mismatch differently
export const parseClientMessage = (raw: string): ClientMessage | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;

  const type = data.type;
  switch (type) {
    case "join": {
      if (!hasKeys(data, ["type", "v", "room", "name", "card"])) return null;
      if (!Number.isInteger(data.v)) return null;
      const room = cleanRoomName(data.room);
      const name = cleanPlayerName(data.name);
      const card = parseCard(data.card);
      if (room === null || name === null || card === null) return null;
      return { type, v: data.v as number, room, name, card };
    }
    case "lock":
    case "unlock": {
      if (!hasKeys(data, ["type", "target"])) return null;
      const target = parseTarget(data.target);
      return target === null ? null : { type, target };
    }
    case "text": {
      if (!hasKeys(data, ["type", "target", "text"])) return null;
      const target = parseTarget(data.target);
      if (target === null) return null;
      const text =
        target === "title" ? cleanTitle(data.text) : cleanSquare(data.text);
      return text === null ? null : { type, target, text };
    }
    case "mark": {
      if (!hasKeys(data, ["type", "i", "on"])) return null;
      if (!isIndex(data.i) || typeof data.on !== "boolean") return null;
      return { type, i: data.i, on: data.on };
    }
    case "settings": {
      if (!hasKeys(data, ["type"], SETTING_KEYS)) return null;
      const settings = parseSettings(data);
      if (!settings || !Object.keys(settings).length) return null;
      return { type, ...settings };
    }
    case "clear":
    case "clear-marks":
    case "ping":
      return hasKeys(data, ["type"]) ? { type } : null;
    default:
      return null;
  }
};
