import { expect } from "vitest";
import { createRecoveryKey } from "../backup";
import { connector } from "../host";
import { pfFill } from "../page-fns";
import type { StepPages } from "../ports";
import { runnerListener } from "../security-listener";
import { isOwnPage } from "../sender";
import { createRunnerService } from "../service";
import { ORIGIN, genuineRunnerPermit } from "./genuine-runner-permit.fixture";
import { heldRunnerHttp } from "./held-runner-http.fixture";

export function physicalHold() {
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started: startedPromise,
    release,
    async pause() {
      started();
      await released;
    },
  };
}
function actualPage(page: { opened: number; filled: number }): StepPages {
  page.opened += 1;
  const field = document.createElement("input");
  field.id = "held-runner-field";
  document.body.replaceChildren(field);
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
}
function physicalDeps(
  f: Awaited<ReturnType<typeof genuineRunnerPermit>>,
  base: string,
  page: { opened: number; filled: number },
) {
  return {
    settings: f.settings,
    vault: f.vault,
    grants: {
      has: async (origin: string) => f.granted.has(origin),
      revoke: async (origin: string) => {
        f.granted.delete(origin);
      },
      privateAllowed: async () => true,
    },
    connect: connector(f.settings, async () => base),
    pagesFor: async () => actualPage(page),
    closePage: async () => {},
  };
}
function trustedListener(
  f: Awaited<ReturnType<typeof genuineRunnerPermit>>,
  runner: ReturnType<typeof createRunnerService>,
) {
  const own = "abcdefghijklmnopabcdefghijklmnop";
  const base = `chrome-extension://${own}/`;
  return {
    sender: { id: own, url: `${base}options.html` },
    listen: runnerListener(runner, f.broker, (from) =>
      isOwnPage(from, own, base),
    ),
  };
}
/** Real broker/owner, AES records and physical HTTP; page adapter executes the actual DOM function. */
export async function runnerAuthorityLifecycle(
  stage: "list" | "claim" | "none",
  token = true,
) {
  const f = await genuineRunnerPermit();
  const http = await heldRunnerHttp(stage);
  const pair = await createRecoveryKey();
  expect(await f.vault.setRecipient(pair.recipient.jwk)).not.toBeNull();
  if (token) await f.settings.setToken("public-runner-host-session");
  const page = { opened: 0, filled: 0 };
  const deps = physicalDeps(f, http.base, page);
  const runner = createRunnerService(deps);
  trustedListener(f, runner);
  async function arm(permit: string | undefined, target = runner) {
    const { listen, sender } = trustedListener(f, target);
    const reply = await new Promise<object>((resolve) =>
      listen(
        {
          type: "opensesame.runner.arm",
          origin: ORIGIN,
          securityPermit: permit,
        },
        sender,
        resolve,
      ),
    );
    expect(reply).toEqual({ result: "armed" });
  }
  async function close() {
    http.release();
    f.close();
    await http.close();
  }
  return {
    f,
    http,
    page,
    runner,
    deps,
    arm,
    close,
    restart() {
      const fresh = createRunnerService(deps);
      trustedListener(f, fresh);
      return fresh;
    },
  };
}
