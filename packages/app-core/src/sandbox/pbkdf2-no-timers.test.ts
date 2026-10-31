import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pbkdf2WithoutTimers } from "./pbkdf2-no-timers.js";

const encoder = new TextEncoder();

describe("timerless PBKDF2", () => {
  it.each([
    [1, 1],
    [2, 32],
    [17, 33],
    [1000, 64],
  ])(
    "matches Node PBKDF2 at %i iterations and %i bytes",
    async (rounds, size) => {
      const password = encoder.encode("password 🔐");
      const salt = encoder.encode("salt\u0000value");
      const actual = await pbkdf2WithoutTimers(password, salt, rounds, size);
      expect(actual).toEqual(
        new Uint8Array(pbkdf2Sync(password, salt, rounds, size, "sha256")),
      );
    },
  );

  it("yields to a microtask when the clock passes the work budget", async () => {
    let clock = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 11;
      return clock;
    });
    try {
      let yielded = false;
      const pending = pbkdf2WithoutTimers(
        encoder.encode("password"),
        encoder.encode("salt"),
        3,
        32,
      );
      Promise.resolve().then(() => {
        yielded = true;
      });
      await Promise.resolve();
      expect(yielded).toBe(true);
      expect(await pending).toEqual(
        new Uint8Array(pbkdf2Sync("password", "salt", 3, 32, "sha256")),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects invalid parameters", async () => {
    const empty = new Uint8Array();
    await expect(pbkdf2WithoutTimers(empty, empty, 0, 32)).rejects.toThrow();
    await expect(pbkdf2WithoutTimers(empty, empty, 1, 0)).rejects.toThrow();
  });
});
