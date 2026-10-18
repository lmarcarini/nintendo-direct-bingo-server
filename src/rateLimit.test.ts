import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit.ts";

describe("createRateLimiter", () => {
  it("allows a burst, then refills at the given rate", () => {
    let time = 0;
    const allow = createRateLimiter(3, 10, () => time);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    time = 50; // half a token
    expect(allow()).toBe(false);
    time = 100;
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });

  it("never holds more than the burst", () => {
    let time = 0;
    const allow = createRateLimiter(2, 10, () => time);
    time = 60_000;
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
  });
});
