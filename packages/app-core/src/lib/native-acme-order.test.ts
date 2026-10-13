import { expect, it, vi } from "vitest";
import {
  beginAcmeOrder,
  finishAcmeOrder,
  registerAcmeAccount,
} from "./native-acme-order.js";
import {
  acmeAccountKey,
  generateAcmeAccountJwk,
  openAcme,
} from "./native-acme-protocol.js";
import { PEM_CHAIN, fakeAcme } from "./native-acme.test-support.js";
import type { FakeAcmeOptions } from "./native-acme.test-support.js";

async function opened(options: FakeAcmeOptions) {
  const ca = fakeAcme(options);
  const key = await acmeAccountKey(await generateAcmeAccountJwk());
  const client = await openAcme("staging", key, ca.transport);
  const account = await registerAcmeAccount(client);
  const order = await beginAcmeOrder(client, key, account, ["example.org"]);
  return { client, account, order };
}

it("waits as long as the CA says between looks at an order it is still issuing", async () => {
  const wait = vi.fn(async () => undefined);
  const { client, account, order } = await opened({
    publish: true,
    processingPolls: 2,
  });
  const done = await finishAcmeOrder(client, account, order.orderUrl, wait);
  expect(done.chain).toBe(PEM_CHAIN);
  // Retry-After: 1 is a second, in milliseconds, each time the order was not yet valid.
  expect(wait.mock.calls).toEqual([[1000], [1000]]);
});

it("stops asking after a bounded number of looks, and says to try again", async () => {
  const wait = vi.fn(async () => undefined);
  const { client, account, order } = await opened({
    publish: true,
    processingPolls: 1000,
  });
  await expect(
    finishAcmeOrder(client, account, order.orderUrl, wait),
  ).rejects.toThrow("Try Finish again");
  expect(wait).toHaveBeenCalledTimes(20);
});

it("never waits longer than ten seconds, whatever Retry-After says", async () => {
  const wait = vi.fn(async () => undefined);
  const ca = fakeAcme({ publish: true, processingPolls: 1 });
  const original = ca.fetch.getMockImplementation();
  ca.fetch.mockImplementation(async (input, init) => {
    const response = await original?.(input, init);
    if (!response) throw new Error("no response");
    if (response.headers.has("retry-after")) {
      const headers = new Headers(response.headers);
      headers.set("retry-after", "86400");
      return new Response(await response.text(), {
        status: response.status,
        headers,
      });
    }
    return response;
  });
  const key = await acmeAccountKey(await generateAcmeAccountJwk());
  const client = await openAcme("staging", key, ca.transport);
  const account = await registerAcmeAccount(client);
  const order = await beginAcmeOrder(client, key, account, ["example.org"]);
  await finishAcmeOrder(client, account, order.orderUrl, wait);
  expect(wait.mock.calls).toEqual([[10_000]]);
});
