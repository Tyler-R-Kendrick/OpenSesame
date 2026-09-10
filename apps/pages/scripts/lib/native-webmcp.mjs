import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** DevTools' own tool discovery and invocation channel, never an app registry. */
export async function nativeWebMcp(page) {
  const cdp = await page.context().newCDPSession(page);
  const tools = new Map();
  const responses = new Map();
  let calls = 0;
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId) tools.clear();
  });
  await cdp.send("Page.enable");
  cdp.on("WebMCP.toolsAdded", ({ tools: added }) => {
    for (const tool of added) tools.set(tool.name, tool);
  });
  cdp.on("WebMCP.toolsRemoved", ({ tools: removed }) => {
    for (const tool of removed) tools.delete(tool.name);
  });
  cdp.on("WebMCP.toolResponded", (response) =>
    responses.set(response.invocationId, response),
  );
  await cdp.send("WebMCP.enable");
  async function invoke(name, input = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `Chrome did not register ${name}`);
    const { invocationId } = await cdp.send("WebMCP.invokeTool", {
      frameId: tool.frameId,
      toolName: name,
      input,
    });
    calls += 1;
    await until(
      () => responses.has(invocationId),
      `Chrome did not finish ${name}`,
    );
    const response = responses.get(invocationId);
    responses.delete(invocationId);
    assert.equal(
      response.status,
      "Completed",
      `${name}: ${response.errorText}`,
    );
    assert.notEqual(
      response.output.isError,
      true,
      JSON.stringify(response.output),
    );
    return JSON.parse(response.output.content[0].text);
  }
  return {
    names: () => [...tools.keys()].sort(),
    invocations: () => calls,
    expectCount: (count) =>
      until(
        () => tools.size === count,
        `Expected ${count} native tools; got ${[...tools.keys()]}`,
      ),
    invoke,
    async refuse(name, input) {
      await assert.rejects(() => invoke(name, input));
    },
  };
}

async function until(condition, message) {
  const deadline = Date.now() + 10000;
  while (!condition() && Date.now() < deadline) await delay(25);
  assert.ok(condition(), message);
}
