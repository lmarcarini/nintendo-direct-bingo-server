// The server's settings, read once from the environment at startup. Every
// variable has a default; a value that's set but invalid throws, so a bad
// deploy fails right away rather than running with surprising limits

export type Config = {
  port: number;
  allowedOrigins: string[];
  maxRooms: number;
  maxPlayersPerRoom: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxMessageBytes: number;
  handshakeTimeoutMs: number;
  roomGraceMs: number;
  lockTimeoutMs: number;
  rateBurst: number;
  ratePerSec: number;
};

type Env = Record<string, string | undefined>;

const readInt = (env: Env, name: string, fallback: number, max: number) => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return value;
};

const readOrigins = (env: Env) => {
  const raw = env.ALLOWED_ORIGINS ?? "http://localhost:5173";
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length) throw new Error("ALLOWED_ORIGINS is empty");
  for (const origin of origins) {
    // Browsers send the bare origin: scheme, host and port, no slash or path
    if (!URL.canParse(origin) || new URL(origin).origin !== origin)
      throw new Error(
        `ALLOWED_ORIGINS entries must look like https://example.com, got "${origin}"`
      );
  }
  return origins;
};

const MAX = 1_000_000;
const MAX_MS = 24 * 60 * 60 * 1000;

export const loadConfig = (env: Env = process.env): Config => ({
  port: readInt(env, "PORT", 8080, 65535),
  allowedOrigins: readOrigins(env),
  maxRooms: readInt(env, "MAX_ROOMS", 5, MAX),
  maxPlayersPerRoom: readInt(env, "MAX_PLAYERS_PER_ROOM", 8, MAX),
  maxConnections: readInt(env, "MAX_CONNECTIONS", 50, MAX),
  maxConnectionsPerIp: readInt(env, "MAX_CONNECTIONS_PER_IP", 10, MAX),
  maxMessageBytes: readInt(env, "MAX_MESSAGE_BYTES", 32768, 1024 * 1024),
  handshakeTimeoutMs: readInt(env, "HANDSHAKE_TIMEOUT_MS", 5000, MAX_MS),
  roomGraceMs: readInt(env, "ROOM_GRACE_MS", 60000, MAX_MS),
  lockTimeoutMs: readInt(env, "LOCK_TIMEOUT_MS", 30000, MAX_MS),
  rateBurst: readInt(env, "RATE_BURST", 20, MAX),
  ratePerSec: readInt(env, "RATE_PER_SEC", 10, MAX),
});
