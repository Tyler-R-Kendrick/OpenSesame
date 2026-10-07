// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRecoveryKey } from "./backup";
import { connector } from "./host";
import { pfFill } from "./page-fns";
import { runnerListener } from "./security-listener";
import { isOwnPage } from "./sender";
import { createRunnerService } from "./service";
import {
  ORIGIN,
  closeGenuineRunnerFixtures,
  genuineRunnerPermit,
} from "./test-support/genuine-runner-permit.fixture";
import { heldRunnerHttp } from "./test-support/held-runner-http.fixture";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
});
afterEach(async () => {
  closeGenuineRunnerFixtures();
  vaultStore.lock();
  await kvFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
  document.body.replaceChildren();
});

it.each(["current", "disconnect", "expiry", "synthetic"])(
  "retains original worker authority through a physical streamed Host body: %s",
  async (interruption) => {
    const f = await genuineRunnerPermit();
    const http = await heldRunnerHttp();
    let tick: Promise<unknown> | undefined;
    try {
      const retired = "public-retired-runner-authority";
      if (interruption === "synthetic") {
        await vaultStore.unlock(f.owner.password);
        await enrollRetiredCredential({
          tomb: PERSONAL_TOMB,
          currentPassword: f.owner.password,
          retiredPassword: retired,
          response: "synthetic_decoy",
          acknowledgePasswordVerifierRisk: true,
        });
        vaultStore.lock();
      }
      const owner = await f.unlock();
      expect(owner.realm).toBe("real");
      await f.settings.setToken("public-runner-host-session");
      const pair = await createRecoveryKey();
      expect(await f.vault.setRecipient(pair.recipient.jwk)).not.toBeNull();
      const page = { opened: 0, filled: 0 };
      const runner = createRunnerService({
        settings: f.settings,
        vault: f.vault,
        grants: {
          has: async (origin) => f.granted.has(origin),
          revoke: async (origin) => {
            f.granted.delete(origin);
          },
          privateAllowed: async () => true,
        },
        connect: connector(f.settings, async () => http.base),
        pagesFor: async () => {
          page.opened += 1;
          document.body.innerHTML = '<input id="held-runner-field">';
          return {
            navigate: async () => "ok",
            waitFor: async () => "ok",
            fill: async (selector, value) => {
              page.filled += 1;
              return pfFill(selector, value);
            },
            presence: async () => "absent",
            submit: async () => "no_such_element",
            readDom: async () => "",
            layout: async () => "public-fixture-layout",
            capture: async () => null,
            fresh: async () => null,
            close: async () => {},
          };
        },
        closePage: async () => {},
      });
      const own = "abcdefghijklmnopabcdefghijklmnop";
      const base = `chrome-extension://${own}/`;
      const sender = { id: own, url: `${base}options.html` };
      const listen = runnerListener(runner, f.broker, (from) =>
        isOwnPage(from, own, base),
      );
      const arm = await new Promise<object>((resolve) =>
        listen(
          {
            type: "opensesame.runner.arm",
            origin: ORIGIN,
            securityPermit: owner.permit,
          },
          sender,
          resolve,
        ),
      );
      expect(arm).toEqual({ result: "armed" });
      await http.started;
      tick = runner.tick().catch((error: unknown) => error);
      if (interruption === "disconnect") f.port.close();
      else if (interruption === "expiry") f.clock.now += 300_000;
      else if (interruption === "synthetic")
        expect((await f.unlock(retired)).realm).toBe("synthetic");
      http.release();
      await tick;
      http.assertTransport();
      if (interruption === "current") {
        expect(page).toEqual({ opened: 1, filled: 1 });
        expect(
          document.querySelector<HTMLInputElement>("#held-runner-field")?.value,
        ).toBe("public-runner-value");
        expect(
          http.paths.filter((path) => path.endsWith("/steps/claim")),
        ).toHaveLength(1);
        expect(
          http.paths.filter((path) => path.endsWith("/steps/0/outcome")),
        ).toHaveLength(1);
      } else {
        expect(http.paths).toEqual(["/api/v1/agent/runs"]);
        expect(page).toEqual({ opened: 0, filled: 0 });
        expect(document.querySelector("#held-runner-field")).toBeNull();
      }
    } finally {
      http.release();
      await tick;
      f.close();
      await http.close();
    }
  },
);
