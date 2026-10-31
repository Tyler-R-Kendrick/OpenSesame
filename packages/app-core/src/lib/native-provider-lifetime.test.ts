import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  deferredOperation,
  operationOracle,
} from "./native-api-operations.test-support.js";
import { invokeNativeApiResource } from "./native-api-resources.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import { readNativeConnector } from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { ledgerFile } from "./secret-backends/runtime.test-support.js";

const LOCK = "opensesame:device-connectors";

describe("generic provider result ownership", () => {
  installNativeApiTests();
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0).reverse()) await close();
  });
  async function fixture() {
    const oracle = await operationOracle("datadog");
    closes.push(oracle.close);
    const locks = webLocksDouble();
    configureHost(createTestHost({ locks: overlapCast(locks) }));
    oracle.reply((_request, response) => {
      response.end(JSON.stringify([{ id: 17, name: "Private monitor" }]));
    });
    return {
      ...oracle,
      locks,
      read: () => {
        const pending = invokeNativeApiResource(
          "datadog",
          oracle.view.connectionId,
          "provider.monitors.read",
          {},
          oracle.transport,
        );
        if (!pending) throw new Error("Missing actual Datadog resource");
        return pending;
      },
    };
  }

  it("returns the actual provider projection while the original owner stays current", async () => {
    const state = await fixture();
    expect((await state.read()).items).toEqual([
      { id: "17", label: "Private monitor" },
    ]);
    expect(state.requests.at(-1)?.authorized).toBe(true);
  });

  it("refuses a result after withdrawal behind its final actual revision lock", async () => {
    const state = await fixture();
    const entered = deferredOperation();
    const release = deferredOperation();
    let blocker = Promise.resolve();
    state.reply((_request, response) => {
      blocker = state.locks.request(LOCK, async () => {
        entered.resolve();
        await release.promise;
      });
      response.end(JSON.stringify([{ id: 17, name: "Private monitor" }]));
    });
    try {
      const pending = state.read();
      await entered.promise;
      await vi.waitFor(() => {
        expect(
          state.locks.requested.filter((name) => name === LOCK),
        ).toHaveLength(3);
      });
      state.owner.abort();
      release.resolve();
      await expect(pending).rejects.toThrow();
    } finally {
      release.resolve();
      await blocker;
    }
  });

  it("rechecks the public reader after awaiting its authenticated bounded result", async () => {
    const state = await fixture();
    const original = state.transport.assertCurrent;
    let queued = false;
    state.transport.assertCurrent = () => {
      original();
      // Both real revision reads have completed at this truthful check.
      if (
        !queued &&
        state.locks.requested.filter((name) => name === LOCK).length === 2
      ) {
        queued = true;
        queueMicrotask(() => state.owner.abort());
      }
    };
    const pending = state.read();
    await pending.then(
      () => undefined,
      () => undefined,
    );
    expect(queued).toBe(true);
    expect(state.owner.signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
  });
});

describe("configured OAuth resource result ownership", () => {
  const closes: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0).reverse()) await close();
  });
  async function fixture() {
    const state = await nativeOAuthClientFixture("client_secret_post");
    closes.push(state.close);
    closes.push(
      bindNativeOAuthBrowserPort({
        redirectUri: state.owner.redirectUri,
        navigate() {
          throw new Error("Unexpected navigation");
        },
        scrubCallback() {},
        authorize: async (url) => {
          const parsed = new URL(url);
          state.state.challenge =
            parsed.searchParams.get("code_challenge") ?? "";
          return new URLSearchParams({
            native_state: parsed.searchParams.get("state") ?? "",
            native_code: "one-use-code",
          }).toString();
        },
      }),
    );
    let afterCheck = () => undefined;
    const original = state.owner.transport;
    const driver = createNativeOAuthResourceDriver({
      supports: () => true,
      capture: () => ({
        ...state.owner,
        transport: {
          ...original,
          assertCurrent() {
            original.assertCurrent();
            afterCheck();
          },
        },
        close() {},
      }),
    });
    const saved = await driver.configure(state.input);
    if (!driver.authorize)
      throw new Error("Missing actual OAuth authorization");
    await driver.authorize(saved.connectionId);
    return {
      ...state,
      saved,
      afterCheck: (run: () => undefined) => {
        afterCheck = run;
      },
      read: () =>
        driver.invoke(saved.connectionId, "provider.resource.read", {}),
    };
  }

  it("returns the real PKCE-authorized TLS resource while its owner stays current", async () => {
    const state = await fixture();
    const result = await state.read();
    expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual({
      projects: [{ id: "project-42", name: "Actual configured project" }],
    });
    expect(state.requests.map((request) => request.path)).toEqual([
      "/token",
      "/resource",
      "/resource",
    ]);
    expect(
      new URLSearchParams(state.requests[0]?.body).get("client_secret"),
    ).toBe(CLIENT_SECRET);
    expect(state.requests[0]?.authorization).toBe("");
    expect(state.requests[2]?.authorization).toBe("Bearer issued-access-1");
  });

  it("refuses a body when the original owner ends after the physical metadata close", async () => {
    const state = await fixture();
    const priorRevision = readNativeConnector(
      state.saved.connectionId,
    )?.revision;
    let physicallyClosed = false;
    let queued = false;
    const original = state.local.files.set.bind(state.local.files);
    const spy = vi
      .spyOn(state.local.files, "set")
      .mockImplementation((name, value) => {
        const result = original(name, value);
        if (name === ledgerFile) physicallyClosed = true;
        return result;
      });
    state.afterCheck(() => {
      if (physicallyClosed && !queued) {
        queued = true;
        queueMicrotask(() => state.controller.abort());
      }
      return undefined;
    });
    try {
      const pending = state.read();
      await pending.then(
        () => undefined,
        () => undefined,
      );
      expect(physicallyClosed).toBe(true);
      expect(queued).toBe(true);
      expect(state.controller.signal.aborted).toBe(true);
      // The metadata write was accepted; rejection does not pretend to undo it.
      expect(readNativeConnector(state.saved.connectionId)?.revision).toBe(
        (priorRevision ?? 0) + 1,
      );
      await expect(pending).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks the original owner after the public action maps its actual resource body", async () => {
    const state = await fixture();
    let queued = false;
    const original = JSON.stringify;
    const spy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value, replacer, space) => {
        const result = original(value, replacer, space);
        if (space === 2 && value?.projects?.[0]?.id === "project-42") {
          queued = true;
          queueMicrotask(() => state.controller.abort());
        }
        return result;
      });
    try {
      const pending = state.read();
      await pending.then(
        () => undefined,
        () => undefined,
      );
      expect(queued).toBe(true);
      expect(state.controller.signal.aborted).toBe(true);
      await expect(pending).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
