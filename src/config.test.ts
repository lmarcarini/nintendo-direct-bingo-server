import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("has a default for everything", () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      allowedOrigins: ["http://localhost:5173"],
      maxRooms: 5,
      maxPlayersPerRoom: 8,
      maxConnections: 50,
      maxConnectionsPerIp: 10,
      maxMessageBytes: 32768,
      handshakeTimeoutMs: 5000,
      roomGraceMs: 60000,
      lockTimeoutMs: 30000,
      rateBurst: 20,
      ratePerSec: 10,
    });
  });

  it("reads numbers, ignoring surrounding spaces and empty values", () => {
    const config = loadConfig({ PORT: "10000", MAX_ROOMS: " 2 ", RATE_BURST: "" });
    expect(config.port).toBe(10000);
    expect(config.maxRooms).toBe(2);
    expect(config.rateBurst).toBe(20);
  });

  it.each(["abc", "0", "-1", "1.5", "1e3", "0x10"])(
    "rejects %j as a number",
    (value) => {
      expect(() => loadConfig({ MAX_ROOMS: value })).toThrow("MAX_ROOMS");
    }
  );

  it("rejects a port over 65535", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow("PORT");
  });

  it("reads a comma-separated origin list", () => {
    expect(
      loadConfig({
        ALLOWED_ORIGINS: "https://bingo.netlify.app, http://localhost:5173",
      }).allowedOrigins
    ).toEqual(["https://bingo.netlify.app", "http://localhost:5173"]);
  });

  it.each([
    "",
    " , ",
    "bingo.netlify.app",
    "https://bingo.netlify.app/",
    "https://bingo.netlify.app/play",
    "*",
  ])("rejects ALLOWED_ORIGINS=%j", (value) => {
    expect(() => loadConfig({ ALLOWED_ORIGINS: value })).toThrow(
      "ALLOWED_ORIGINS"
    );
  });
});
