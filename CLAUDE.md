# CLAUDE.md

The room server for [Nintendo Direct Bingo](https://github.com/lmarcarini/nintendo-direct-bingo): a small WebSocket server that lets a few friends play one bingo card together in real time. It's a personal project used by a handful of people, so keep it small, with no frameworks and no abstractions a feature doesn't need.

The frontend lives in a sibling folder, `../nintendo-direct-bingo` (React, hosted on Netlify). Its `CLAUDE.md` explains the card model; this file covers only the server. Rooms are an optional extra for the frontend: the card works solo and offline without this server. A failure here should cost players the sync and nothing more.

**Status:** the project is scaffolded and `src/protocol.ts` (types, client message validation, text cleaning) is done and tested. The rest of the layout below is still to build, so `npm start` doesn't run yet.

## Commands

```bash
npm run dev     # node --watch src/server.ts
npm start       # node src/server.ts (what Render runs)
npm run check   # tsc --noEmit (Node strips types at runtime; this is the type check)
npm run lint    # ESLint, --max-warnings 0
npm test        # Vitest (`npm test -- run` runs once)
```

Verify changes with `npm test`, `npm run check` and `npm run lint`. Node comes from `.nvmrc` (24 LTS); run `nvm use`. `engines` allows Node 24+ (running TypeScript directly needs a recent Node, and Vitest 5 supports 24 and 26+), and `.npmrc` sets `engine-strict=true`.

## Stack

Node 24 running TypeScript directly (type stripping), so there's no build step. That requires erasable syntax only: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `.ts` extensions in imports (`allowImportingTsExtensions`), no `enum`, no parameter properties, no namespaces. The only runtime dependency is `ws`. Use `node:http` for the health route; don't use Express or Socket.IO. Dev dependencies match the frontend: TypeScript (strict), ESLint flat config, Vitest.

## Layout

```
src/
  server.ts      http server + GET /healthz, WebSocket upgrade, origin check, connection caps, SIGTERM
  config.ts      env → validated config with defaults; throws at startup on bad values
  protocol.ts    message types + strict validators and text sanitizers (mirrored in the frontend)
  roomCard.ts    pure: the room's card and applying one op to it
  rooms.ts       room registry: join/leave, players, locks, capacity, grace period
  connection.ts  one socket: handshake timeout, rate limit, parse → validate → dispatch
  rateLimit.ts   token bucket
```

Pure modules (`protocol`, `roomCard`, `rooms`, `rateLimit`) don't import `ws`, so they're testable without sockets. Inject time (`now()`) and timers where expiry matters.

## Model

All state is in memory, and nothing is ever written to disk or a database.

```ts
rooms: Map<string, Room>   // a Map, never an object: a room can be named "__proto__"
Room = {
  card: RoomCard,                    // the shared card, already validated
  players: Map<PlayerId, Player>,    // Player = { name, socket }
  locks: Map<Target, Lock>,          // Target = "title" | 0..24; Lock = { by: PlayerId, at: ms }
  emptySince?: number,
}
```

- **The room card** (`RoomCard` in `protocol.ts`) is the frontend's payload with every field present: `t`, `s` (always 25), `n`, `th`, `m`, `mk`, and `a`/`dg`/`el` as `0 | 1`. `t` is `""` for the default title, which the frontend's `fromPayload` turns into its default. The `join` card is the frontend's `toPayload` output (missing fields are defaults) without `v`: view mode belongs to each player and isn't synced. The server sends the full `RoomCard`, which `fromPayload` reads as is.
- **Creation.** The first `join` to a name that has no room creates the room from that player's card. Later joins get the room's card and ignore the card they sent.
- **Freeing.** When the last player leaves, the room is deleted after `ROOM_GRACE_MS`. A rejoin within that window keeps it.
- **Restarts lose everything, by design.** Render restarts and sleeps free services. When a client reconnects to a room that no longer exists, its `join` recreates the room from its local card, which the URL keeps. If two clients rejoin at the same time, the first creates the room and the second joins it.

## Protocol

JSON text frames, one object per message, with `type` as the discriminator. The handshake carries `v` (protocol version, currently `1`), and a mismatch closes with `4000`. `protocol.ts` is the single definition. The frontend keeps a copy of it, and both copies must change together: bump `v` on any incompatible change.

Client → server:

| type       | fields                                  | rule |
| ---------- | --------------------------------------- | ---- |
| `join`     | `v`, `room`, `name`, `card`             | first message, within `HANDSHAKE_TIMEOUT_MS`; `card` is only used if the room is created |
| `lock`     | `target`                                | granted if free or already held by the sender |
| `unlock`   | `target`                                | only the holder can release |
| `text`     | `target`, `text`                        | only accepted from the lock holder; full text, not a diff |
| `mark`     | `i`, `on`                               | sets the mark rather than toggling it, so a repeat is harmless; last write wins |
| `settings` | any of `n`, `th`, `mk`, `a`, `dg`, `el` | last write wins, no lock |
| `clear`    | (none)                                  | empties every square that isn't locked by someone else |
| `ping`     | (none)                                  | answered with `pong`; also keeps Render's free instance awake |

`parseClientMessage` returns the message, or `null` for anything that isn't exactly valid. It cleans text on the way in, so what it returns is safe to store and relay. It accepts any integer `v`; the connection compares it to `PROTOCOL_VERSION`, so a mismatch gets `4000` and not a generic `invalid`. `ServerMessage` only has types for now: the frontend's copy will add a `parseServerMessage` that validates them.

Server → client: `joined { you, card, players, locks }`, `player-joined`, `player-left`, `locked { target, by }`, `unlocked { target }`, `text { target, text, by }`, `mark`, `settings`, `cleared { squares }`, `error { code }` and `pong`.

- **Operations are applied one at a time and sent to everyone, including the sender.** Clients apply what the server sends back, so concurrent marks and settings converge.
- **The one exception is `text`, which isn't sent back to its sender.** It would rewind the cursor of the person typing, and only the lock holder can write that target anyway.
- **A lock is released** on `unlock`, when its holder disconnects, or after `LOCK_TIMEOUT_MS` without a `text` or `lock` from the holder. Each release sends `unlocked`.
- **A refused operation gets an `error` with a code** (`room-full`, `rooms-full`, `name-taken`, `locked`, `invalid`, `rate-limited`, …) and changes nothing. Never echo the input back.

## Security

Every message is untrusted: anyone can open a socket and send anything. The frontend validates too, but the server never relies on it.

**On connection**
- Accept an upgrade only if `Origin` is in `ALLOWED_ORIGINS` (exact match). This only stops other websites, not scripts, so the caps below still apply.
- Cap total connections (`MAX_CONNECTIONS`) and connections per IP (`MAX_CONNECTIONS_PER_IP`). The IP is the first `X-Forwarded-For` entry, which Render sets.
- Close a socket with `4001` if it doesn't send a valid `join` within `HANDSHAKE_TIMEOUT_MS`.
- Ping every socket every 30s and terminate the ones that don't answer.
- Create the `WebSocketServer` with `maxPayload: MAX_MESSAGE_BYTES` and `perMessageDeflate: false` (compression allows CPU and memory abuse).

**For each message**
- Rate-limit each connection with a token bucket (`RATE_BURST`, `RATE_PER_SEC`). Drop messages over the limit and send `rate-limited`, and close with `1008` if it keeps happening.
- Only accept text frames. `JSON.parse` goes inside try/catch.
- Validation is strict, unlike the frontend's lenient `fromPayload`, which fills in defaults for bad links. Here any of the following rejects the message: an unknown `type`, a missing field, an extra key, a wrong type, a non-integer or out-of-range index (`0..24`, `n` ∈ {16, 25}, `m` within 25 bits).
- **Theme and marker ids** are only checked for format (`^[a-z0-9-]{1,32}$`). The frontend maps unknown ids to defaults, so adding a theme doesn't need a server deploy.
- Build every stored object field by field from validated values. Never spread or `Object.assign` input, and never use input as an object key.

**Text** (in `protocol.ts`, applied to the room name, player name, title and squares)
- Normalize to NFC, strip control characters (squares keep `\n`, collapsed to at most 2 in a row) and bidi override/isolate characters (U+202A–U+202E, U+2066–U+2069), then trim.
- Length limits are in code points, after cleaning: title ≤ 80, square ≤ 150, player name 1–20, unique within a room (case-insensitive). The frontend applies the same limits.
- Room names are lowercased and must match `^[a-z0-9-]{3,32}$`. A room name works as its password, so the frontend should suggest one that's hard to guess.
- Text is never interpreted, only stored and relayed. The frontend renders it with `textContent`.

**Operations**
- Log counts, error codes and room lifecycle events. Never log card text, player names or room names.
- On `SIGTERM` (Render sends it on every deploy), close every socket with `1012` so clients reconnect and recreate their rooms, then exit.
- Dependencies: `ws` only at runtime. Commit the lockfile, install with `npm ci`, and turn on Dependabot.

## Config

Read once in `config.ts` and validated (positive integers, non-empty origin list). Invalid values throw at startup.

| Variable                 | Default                 |
| ------------------------ | ----------------------- |
| `PORT`                   | `8080` (Render sets it) |
| `ALLOWED_ORIGINS`        | `http://localhost:5173` (comma-separated; set the Netlify URL in production) |
| `MAX_ROOMS`              | `5`                     |
| `MAX_PLAYERS_PER_ROOM`   | `8`                     |
| `MAX_CONNECTIONS`        | `50`                    |
| `MAX_CONNECTIONS_PER_IP` | `10`                    |
| `MAX_MESSAGE_BYTES`      | `32768`                 |
| `HANDSHAKE_TIMEOUT_MS`   | `5000`                  |
| `ROOM_GRACE_MS`          | `60000`                 |
| `LOCK_TIMEOUT_MS`        | `30000`                 |
| `RATE_BURST`             | `20`                    |
| `RATE_PER_SEC`           | `10`                    |

## Tests

- **Unit tests (Vitest)** sit next to the module they test (`protocol.ts` → `protocol.test.ts`), with no globals. Cover lots of invalid inputs for `protocol.ts` (it's the security boundary), the operation and lock rules in `roomCard`/`rooms` (holder-only text, timeouts, release on disconnect, clear skipping locked squares, grace period, caps), and `config.ts` defaults and rejections.
- **One integration test file** starts the server on port 0 and connects real `ws` clients: join/create, a second player getting the snapshot, operations sent to everyone, lock contention, origin refused, oversized message, handshake timeout.
- Playwright tests that play across two browsers live in the frontend repo.

## Deploy (Render, free plan)

A Web Service connected to this GitHub repo: runtime Node, build `npm ci`, start `npm start`, health check path `/healthz`, region Virginia (closest to Brazil). Set `ALLOWED_ORIGINS` to the Netlify URL. The server must listen on `process.env.PORT`, on all interfaces.

The free plan sleeps after 15 minutes without inbound traffic and takes about a minute to wake up. The frontend shows "connecting…" in the meantime and sends a `ping` every few minutes while in a room. Restarts can happen at any time, which the rejoin-recreates rule above handles. The plan includes 750 instance hours a month.
