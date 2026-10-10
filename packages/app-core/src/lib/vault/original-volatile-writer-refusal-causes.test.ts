/** Genuine RAM/no-lock writer callbacks; these controls exercise refusal behavior, never grant authority. */
import { expect, it } from "vitest";
import { runOriginalVolatileWriterRequestData } from "./original-volatile-writer-request-data.js";

it.each([Number.NaN, -0, 0])(
  "preserves the exact original numeric rejection cause %s after accepted work drain",
  async (cause) => {
    const accepted = runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      () => {},
      () => Promise.reject(cause),
    );
    await expect(accepted).rejects.toBe(cause);
  },
);

it("retains the original object refusal identity rather than wrapping duplicate accepted failure", async () => {
  const cause = new Error("Original accepted work refused.");
  await expect(
    runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      () => {},
      () => Promise.reject(cause),
    ),
  ).rejects.toBe(cause);
});

it("successful work still refuses when its exact original delivery retires", async () => {
  const cause = new Error("Original callback retired.");
  let live = true;
  const original = () => {
    if (!live) throw cause;
  };
  await expect(
    runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      original,
      async () => {
        live = false;
        return "unusable-result";
      },
    ),
  ).rejects.toBe(cause);
});
