// A token bucket: up to `burst` messages at once, refilled at `perSec`.
// Returns a function that takes a token and says whether one was available
export const createRateLimiter = (
  burst: number,
  perSec: number,
  now: () => number = Date.now
) => {
  let tokens = burst;
  let last = now();
  return () => {
    const time = now();
    tokens = Math.min(burst, tokens + ((time - last) / 1000) * perSec);
    last = time;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
};
