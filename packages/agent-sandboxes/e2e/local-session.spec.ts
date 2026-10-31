import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
  type LocalProviderOptions,
  LocalSandboxProvider,
} from "../src/local-provider.js";

test("local provider resumes the same browser only under the same policy", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<html><body><label for="email">Email</label><input id="email" type="email"></body></html>',
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).safeParse(site.address());
  if (!address.success) throw new Error("site failed to bind");
  const origin = `http://127.0.0.1:${address.data.port}`;
  const options: LocalProviderOptions = {
    executable: process.env.AGENT_BROWSER ?? "agent-browser",
  };
  const browserExecutable = process.env.AGENT_BROWSER_CHROME;
  if (browserExecutable) options.browserExecutable = browserExecutable;
  const provider = new LocalSandboxProvider(options);
  const original = await provider.allocate({
    origin,
    session: `run-${crypto.randomUUID()}`,
  });
  try {
    await original.browser.open(`${origin}/reset`);
    const resumed = await provider.allocate({
      origin,
      session: original.session,
    });
    expect(await resumed.browser.pageUrl?.()).toBe(`${origin}/reset`);
    expect((await resumed.browser.snapshot()).fields).toContainEqual(
      expect.objectContaining({ kind: "email", label: "Email" }),
    );
    await expect(
      provider.allocate({
        origin: origin.replace("http:", "https:"),
        session: original.session,
      }),
    ).rejects.toThrow("does not match the allocation policy");
  } finally {
    await original.close().catch(() => {});
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
