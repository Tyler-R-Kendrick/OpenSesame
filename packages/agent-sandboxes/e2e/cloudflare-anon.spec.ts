/**
 * Live anonymous Cloudflare ceremony (opt-in, real network):
 * provision a temporary account (no signup, no claim), deploy the
 * relay + a mock account site as Workers, run the full password
 * reset through the WASM lane, and verify server-side in KV that
 * the password actually rotated. Run with OPENSESAME_LIVE_CF=1.
 */
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
  WasmRelayProvider,
  createTemporaryKvNamespace,
  deployAnonymousCloudflareRelay,
  deployTemporaryWorker,
  provisionCloudflareTemporaryAccount,
} from "../src/index.js";

const LIVE = process.env.OPENSESAME_LIVE_CF === "1";

const TARGET_SOURCE = `
const DEFAULTS = { submissions: 0, current: "old-password-123" };
export default {
  async fetch(request, env) {
    const state = (await env.STATE.get("s", "json")) ?? { ...DEFAULTS };
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json(state);
    if (url.pathname === "/done") {
      const done = (request.headers.get("cookie") ?? "").includes("reset=done");
      return new Response("<html><body><h1>" + (done ? "Password updated" : "Not updated") + "</h1></body></html>",
        { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      const form = await request.formData();
      const ok = form.get("current_password") === state.current
        && String(form.get("new_password") ?? "").length >= 8
        && form.get("new_password") === form.get("confirm_password");
      if (!ok) return new Response("Rejected", { status: 400 });
      state.submissions += 1;
      state.current = String(form.get("new_password"));
      await env.STATE.put("s", JSON.stringify(state));
      return new Response(null, { status: 302, headers: { location: "/done", "set-cookie": "reset=done; Path=/; HttpOnly" } });
    }
    return new Response(
      '<html><body><h1>Change password</h1><form method="POST" action="/reset">' +
      '<label>Current password <input type="password" name="current_password"></label>' +
      '<label>New password <input type="password" name="new_password"></label>' +
      '<label>Confirm new password <input type="password" name="confirm_password"></label>' +
      '<button type="submit">Update password</button></form></body></html>',
      { headers: { "content-type": "text/html" } });
  },
};
`;

test.skip(!LIVE, "set OPENSESAME_LIVE_CF=1 for the live anonymous ceremony");
test.setTimeout(300_000);

test("anonymous Cloudflare: provision, deploy, reset, verify — no claim", async () => {
  const account = await provisionCloudflareTemporaryAccount({});
  const kvId = await createTemporaryKvNamespace(account, "os-target-state");
  // The target must exist before the relay can bind to it as a service.
  await deployTemporaryWorker(account, "os-target", TARGET_SOURCE, [
    { type: "kv_namespace", name: "STATE", namespace_id: kvId },
  ]);
  const deployed = await deployAnonymousCloudflareRelay({
    account,
    serviceBindings: { "os-target.": "os-target" },
  });
  try {
    const subdomain = new URL(deployed.relayUrl).hostname
      .split(".")
      .slice(1)
      .join(".")
      .replace(/\.workers\.dev$/u, "");
    const targetBase = `https://os-target.${subdomain}.workers.dev`;
    const provider = new WasmRelayProvider({
      relayUrl: deployed.relayUrl,
      relayToken: deployed.relayToken,
    });
    const sandbox = await provider.allocate({ origin: `${targetBase}/reset` });
    try {
      const browser = sandbox.browser;
      await browser.open(`${targetBase}/reset`);
      const observation = await browser.snapshot();
      const passwords = observation.fields.filter(
        (field) => field.kind === "password",
      );
      expect(passwords).toHaveLength(3);
      await browser.fillSecret(passwords[0]?.ref ?? "", "old-password-123");
      await browser.fillSecret(
        passwords[1]?.ref ?? "",
        "new-anon-password-456",
      );
      await browser.fillSecret(
        passwords[2]?.ref ?? "",
        "new-anon-password-456",
      );
      const submit = (await browser.snapshot()).fields.find(
        (field) => field.kind === "button",
      );
      expect(submit).toBeDefined();
      await browser.click(submit?.ref ?? "");
      expect(await browser.pageUrl?.()).toBe(`${targetBase}/done`);
    } finally {
      await sandbox.close();
    }
    const state = z
      .object({ submissions: z.number(), current: z.string() })
      .parse(await (await fetch(`${targetBase}/state`)).json());
    expect(state.submissions).toBe(1);
    expect(state.current).toBe("new-anon-password-456");
  } finally {
    await deployed.close();
  }
});
