/** Transport ordering only; these controls never claim Store authentication or REAL membership. */
import { expect, it } from "vitest";
import { OriginalRealOperationTurn } from "./original-real-operation-turn.js";
import {
  RetiredOperationEntries,
  RetiredOperationExchange,
} from "./retired-operation-exchange.js";
it("holds accepted ciphertext until actual private caller completes its drain", async () => {
  const controller = new AbortController();
  const turn = new OriginalRealOperationTurn(controller.signal);
  let delivered = false;
  const result = turn.execute({ kind: "export-sealed" }).then((value) => {
    delivered = true;
    return value;
  });
  await turn.next();
  turn.accept("controlled authenticated ciphertext");
  await Promise.resolve();
  expect(delivered).toBe(false);
  expect(() => turn.execute({ kind: "export-sealed" })).toThrow();
  turn.finish();
  expect(await result).toBe("controlled authenticated ciphertext");
});
it("rejects accepted data on producer cancellation before final delivery", async () => {
  const controller = new AbortController();
  const turn = new OriginalRealOperationTurn(controller.signal);
  const result = turn.execute({ kind: "export-sealed" });
  await turn.next();
  turn.accept("controlled authenticated ciphertext");
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(() => turn.finish()).toThrow();
});
it("reserves accepted UI task before reentrant callbacks without granting authority", async () => {
  const entries = new RetiredOperationEntries();
  const release = entries.reserve();
  expect(entries.busy()).toBe(true);
  expect(() => entries.reserve()).toThrow();
  const exchange = new RetiredOperationExchange(new AbortController().signal);
  entries.set(exchange.challenge, exchange);
  release();
  expect(entries.busy()).toBe(true);
  entries.finish(exchange);
  expect(entries.busy()).toBe(false);
  await exchange.drain();
});
