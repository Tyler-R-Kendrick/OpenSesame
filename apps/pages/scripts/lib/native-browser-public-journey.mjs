/** Physical public OAuth controls, actual callback bridge, encrypted cold reload. */
import { isDeepStrictEqual } from "node:util";
import { expect } from "@playwright/test";
import { nativeVisit } from "./native-browser-catalog-journey.mjs";
import { NATIVE_BROWSER_MCP_INPUT_SCHEMA } from "./native-browser-mcp-rpc.mjs";
import { unlockWithPin } from "./pages-journey.mjs";
import { expectInTray } from "./tray-contract.mjs";

export async function approveNativePublicConsent(
  page,
  callback,
  authorizeButton,
) {
  await authorizeButton.click();
  await page
    .getByRole("heading", { name: "Protocol test consent", exact: true })
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("link", { name: "Approve protocol test consent", exact: true })
    .click();
  await page.waitForURL(
    (url) =>
      url.origin === new URL(callback).origin &&
      url.pathname.endsWith("/connections"),
    { timeout: 30_000 },
  );
  await unlockWithPin(page);
}

export async function noNativeSecrets(page, secrets, check) {
  const text = await page.locator("body").innerText();
  const local = await page.evaluate(() =>
    JSON.stringify(Object.entries(localStorage)),
  );
  for (const value of secrets) {
    check(
      !text.includes(value),
      "private issued credentials never appear in rendered prose",
    );
    check(
      !local.includes(value),
      "private issued credentials never appear in browser localStorage",
    );
  }
}

export async function nativeMcpJourney(
  page,
  harness,
  authority,
  { base, out, label, callback },
) {
  const mark = await authorizeAndReloadMcp(page, harness, authority, {
    base,
    label,
    callback,
  });
  await assertMcpUnsafeSchemaRefusal(page, harness, authority);
  await page
    .getByRole("button", { name: "Discover MCP tools", exact: true })
    .click();
  await page
    .locator("summary")
    .filter({
      hasText: "provider.search: Search the disclosed protocol authority",
    })
    .click();
  const tool = page.getByRole("button", {
    name: "provider.search: Search the disclosed protocol authority",
    exact: true,
  });
  await tool.waitFor();
  await assertMcpArgumentGuide(page, harness);
  const input = page.getByRole("textbox", {
    name: "Tool arguments (JSON object)",
    exact: true,
  });
  await input.fill('{"query":"sealed browser MCP proof"}');
  await tool.click();
  await page
    .getByText("Protocol authority returned: sealed browser MCP proof", {
      exact: true,
    })
    .waitFor();
  harness.check(
    authority.state.calls.filter((call) => call.rpc === "tools/call").length ===
      1,
    "exactly one real advertised tool call crossed the provider boundary",
  );
  await noNativeSecrets(page, authority.secrets, harness.check);
  await page
    .getByText("Protocol authority returned: sealed browser MCP proof", {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${out}/${label}-mcp-tool-result.png`,
    fullPage: false,
    animations: "disabled",
  });
  const geometry = await nativeProtocolGeometry(page);
  harness.check(
    geometry.documentWidth <= geometry.viewportWidth,
    "verified tool result fits the physical browser viewport without horizontal overflow",
  );
  await nativeMcpFailureAndCleanup(page, harness, authority, {
    input,
    tool,
    mark,
  });
  return {
    label,
    providerId: "adobe",
    protocolCalls: authority.state.calls,
    geometry,
    assurance:
      "production UI against disclosed HTTP protocol authority; no live account",
  };
}

async function nativeMcpFailureAndCleanup(
  page,
  harness,
  authority,
  { input, tool, mark },
) {
  const calls = authority.state.calls.filter(
    (call) => call.rpc === "tools/call",
  ).length;
  await assertMcpJsonArgumentFailures(page, harness, authority, input, tool);
  await input.fill('{"query":42}');
  await tool.click();
  await assertMcpArgumentFailure(page);
  await expect(tool).toBeEnabled();
  await input.fill("{}");
  await tool.click();
  await assertMcpArgumentFailure(page);
  await expect(tool).toBeEnabled();
  harness.check(
    authority.state.calls.filter((call) => call.rpc === "tools/call").length ===
      calls,
    "actual server input schema explains invalid types and missing required arguments in the notifications tray before HTTP dispatch",
  );
  await input.fill('{"query":"expired grant proof"}');
  authority.state.rejectTools = true;
  await tool.click();
  await expect(mark).toHaveCount(0);
  harness.check(
    authority.state.calls.filter((call) => call.rpc === "tools/call").length ===
      calls + 1,
    "provider 401 removes verified status and never replays the tool mutation",
  );
  authority.state.rejectTools = false;
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await expect
    .poll(() => authority.state.calls.some((call) => call.method === "DELETE"))
    .toBe(true);
  harness.check(
    authority.state.calls.filter(
      (call) => call.url === authority.metadata.revocationEndpoint,
    ).length === 2,
    "disconnect revokes issued refresh and access tokens",
  );
}

export function nativeProtocolGeometry(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    pointerCoarse: matchMedia("(pointer: coarse)").matches,
  }));
}

async function authorizeAndReloadMcp(
  page,
  harness,
  authority,
  { base, label, callback },
) {
  harness.setStep(`${label}-mcp-public`);
  await nativeVisit(page, base, "connections/adobe");
  await page.getByRole("heading", { name: "Adobe", exact: true }).waitFor();
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Adobe protocol proof");
  await page.locator("summary").filter({ hasText: "MCP permissions" }).click();
  await page.getByRole("checkbox", { name: "openid", exact: true }).check();
  await page
    .getByRole("button", { name: "Verify and connect Adobe", exact: true })
    .click();
  const mark = page.getByRole("img", {
    name: "Adobe access verified",
    exact: true,
  });
  harness.check(
    (await mark.count()) === 0,
    "saved MCP configuration alone is never verified",
  );
  await approveNativePublicConsent(
    page,
    callback,
    page.getByRole("button", {
      name: "Authorize MCP permissions",
      exact: true,
    }),
  );
  await mark.waitFor({ timeout: 30_000 });
  harness.check(
    authority.state.calls.some((call) => call.rpc === "initialize") &&
      authority.state.calls.some((call) => call.rpc === "tools/list"),
    "MCP authorization runs real SDK initialize and actual tools discovery",
  );
  await noNativeSecrets(page, authority.secrets, harness.check);
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await mark.waitFor({ timeout: 30_000 });
  harness.check(true, "verified MCP proof survives PIN-sealed cold reload");
  return mark;
}

async function assertMcpArgumentGuide(page, harness) {
  await page.getByText("Required fields: query", { exact: true }).waitFor();
  const disclosure = page
    .locator("summary")
    .filter({ hasText: "Advertised argument schema" });
  await disclosure.click();
  const schema = page.getByLabel("Advertised argument schema", { exact: true });
  await schema.waitFor();
  harness.check(
    isDeepStrictEqual(
      JSON.parse(await schema.innerText()),
      NATIVE_BROWSER_MCP_INPUT_SCHEMA,
    ),
    "operator sees the exact advertised argument schema and required fields before entering JSON",
  );
  await disclosure.click();
}

async function assertMcpArgumentFailure(
  page,
  message = "Enter arguments that match this tool’s advertised input schema.",
) {
  await page
    .getByRole("region", { name: "MCP tools", exact: true })
    .getByRole("img", { name: message, exact: true })
    .waitFor();
  await expectInTray(page, message);
}

async function assertMcpJsonArgumentFailures(
  page,
  harness,
  authority,
  input,
  tool,
) {
  const before = authority.state.calls.length;
  for (const value of ['{"query":', "[]"]) {
    await input.fill(value);
    await tool.click();
    await assertMcpArgumentFailure(
      page,
      "Enter valid JSON object arguments for this tool.",
    );
    await expect(tool).toBeEnabled();
  }
  harness.check(
    authority.state.calls.length === before,
    "malformed JSON and non-object arguments receive a precise tray error without any provider HTTP request",
  );
}

async function assertMcpUnsafeSchemaRefusal(page, harness, authority) {
  const discover = page.getByRole("button", {
    name: "Discover MCP tools",
    exact: true,
  });
  const message =
    "This tool’s schema exceeds browser safety limits. Ask the MCP provider for a simpler schema or smaller arguments.";
  for (const position of ["input", "output"]) {
    authority.state.unsafeSchema = position;
    const before = authority.state.calls.filter(
      (call) => call.rpc === "tools/call",
    ).length;
    await discover.click();
    await assertMcpArgumentFailure(page, message);
    await expect(discover).toBeEnabled();
    harness.check(
      authority.state.calls.filter((call) => call.rpc === "tools/call")
        .length === before,
      `unsafe advertised ${position} regex is refused by production schema preflight with a precise tray error before tool dispatch`,
    );
  }
  authority.state.unsafeSchema = null;
}
