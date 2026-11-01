/**
 * Live anonymous Vercel ceremony (opt-in, real network): bootstrap
 * anonymous temporary projects (no signup, no claim), deploy the
 * relay + a mock account site as serverless functions, run the full
 * password reset through the WASM lane, and verify server-side that
 * the password actually rotated. Run with OPENSESAME_LIVE_VERCEL=1.
 */
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
  VercelAnonProvider,
  bootstrapAnonymousVercelProject,
  deployAnonymousVercelApp,
} from "../src/index.js";

const LIVE = process.env.OPENSESAME_LIVE_VERCEL === "1";

const TARGET_SOURCE = `
const state = { submissions: 0, current: "old-password-123" };
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
module.exports = async function handler(req, res) {
  const page = new URL(req.url, "http://x").searchParams.get("p");
  if (page === "state") return res.status(200).json(state);
  if (page === "done") {
    const done = (req.headers.cookie ?? "").includes("reset=done");
    return res.status(200).send("<html><body><h1>" + (done ? "Password updated" : "Not updated") + "</h1></body></html>");
  }
  if (req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const ok = form.get("current_password") === state.current
      && String(form.get("new_password") ?? "").length >= 8
      && form.get("new_password") === form.get("confirm_password");
    if (!ok) return res.status(400).send("Rejected");
    state.submissions += 1;
    state.current = String(form.get("new_password"));
    res.setHeader("set-cookie", "reset=done; Path=/; HttpOnly");
    res.setHeader("location", "/done");
    return res.status(302).send("");
  }
  return res.status(200).send(
    '<html><body><h1>Change password</h1><form method="POST" action="/reset">' +
    '<label>Current password <input type="password" name="current_password"></label>' +
    '<label>New password <input type="password" name="new_password"></label>' +
    '<label>Confirm new password <input type="password" name="confirm_password"></label>' +
    '<button type="submit">Update password</button></form></body></html>');
}
`;

test.skip(!LIVE, "set OPENSESAME_LIVE_VERCEL=1 for the live anonymous ceremony");
test.setTimeout(300_000);

test("anonymous Vercel: bootstrap, deploy, reset, verify — no claim", async () => {
  const targetProject = await bootstrapAnonymousVercelProject();
  const { baseUrl: targetBase } = await deployAnonymousVercelApp(
    targetProject,
    "opensesame-target",
    {
      "api/site.js": TARGET_SOURCE,
      "vercel.json": JSON.stringify({
        rewrites: [
          { source: "/reset", destination: "/api/site?p=reset" },
          { source: "/done", destination: "/api/site?p=done" },
          { source: "/state", destination: "/api/site?p=state" },
        ],
      }),
      "index.html": "<html><body>opensesame target</body></html>",
    },
  );
  const provider = new VercelAnonProvider();
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
    await browser.fillSecret(passwords[1]?.ref ?? "", "new-anon-password-456");
    await browser.fillSecret(passwords[2]?.ref ?? "", "new-anon-password-456");
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
});
