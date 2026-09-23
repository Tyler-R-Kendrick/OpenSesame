import { expect, it, vi } from "vitest";
import { readBoundedObject } from "./bounded-response.js";

it("refuses oversized authority and liveness response bodies", async () => {
  await expect(
    readBoundedObject(Response.json({ payload: "x".repeat(4096) }), 4096, 1000),
  ).rejects.toThrow("Invalid endpoint response");
});
it("does not expose invalid provider response text through errors", async () => {
  await expect(
    readBoundedObject(
      new Response("sentinel-secret-provider-error"),
      4096,
      1000,
    ),
  ).rejects.toThrow(/^Invalid endpoint response$/);
});
it("cancels a stalled response at its body deadline", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  await expect(readBoundedObject(response, 4096, 10)).rejects.toThrow(
    "Invalid endpoint response",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it("only accepts an object envelope", async () => {
  await expect(
    readBoundedObject(Response.json([]), 4096, 1000),
  ).rejects.toThrow("Invalid endpoint response");
  await expect(
    readBoundedObject(Response.json({ status: "ok" }), 4096, 1000),
  ).resolves.toEqual({ status: "ok" });
});
