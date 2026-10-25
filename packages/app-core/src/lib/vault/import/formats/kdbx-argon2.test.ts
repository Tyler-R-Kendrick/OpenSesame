import { expect, it, vi } from "vitest";
import { cappedArgon2Impl } from "./kdbx-argon2.js";

const password = new ArrayBuffer(16);
const salt = new ArrayBuffer(16);

it.each([0, 2])(
  "preserves the KeePassXC default on Argon2 type %i",
  async (type) => {
    const argon2d = vi.fn(async () => new Uint8Array(32));
    const argon2id = vi.fn(async () => new Uint8Array(32));
    const derive = cappedArgon2Impl({ argon2d, argon2id }, 2);
    expect(await derive(password, salt, 65536, 3, 32, 4, type, 0x13)).toEqual(
      new ArrayBuffer(32),
    );
    expect(type === 2 ? argon2id : argon2d).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySize: 65536,
        iterations: 3,
        parallelism: 4,
      }),
    );
  },
);

it.each([
  [1024 * 1024, 1000, 16],
  [65537, 1, 1],
  [65536, 4, 4],
  [1024, 11, 1],
  [1024, 1, 5],
  [Number.NaN, 1, 1],
  [1024, Number.POSITIVE_INFINITY, 1],
  [1024, 1.5, 1],
  [1024, 1, 0],
  [7, 1, 1],
])(
  "rejects unsafe work (%i KiB, %i iterations, %i lanes) before allocation",
  async (memory, iterations, lanes) => {
    const argon2 = vi.fn(async () => new Uint8Array(32));
    const derive = cappedArgon2Impl({ argon2d: argon2, argon2id: argon2 }, 2);
    await expect(
      derive(password, salt, memory, iterations, 32, lanes, 2, 0x13),
    ).rejects.toThrow(/work budget/);
    expect(argon2).not.toHaveBeenCalled();
  },
);

it("allows smaller-memory databases with more iterations within the total budget", async () => {
  const argon2 = vi.fn(async () => new Uint8Array(32));
  const derive = cappedArgon2Impl({ argon2d: argon2, argon2id: argon2 }, 2);
  await derive(password, salt, 16384, 10, 32, 1, 2, 0x13);
  expect(argon2).toHaveBeenCalledOnce();
});
