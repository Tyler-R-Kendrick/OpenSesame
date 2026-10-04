import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFICATION_CLASSES } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

import { createWebPushAdapter } from "../adapters/web-push.js";
import { renderInput } from "./helpers.js";

/**
 * The server half of a contract whose other half lives in the Pages service
 * worker (`apps/pages/src/lib/push.ts`, `pushNotificationBody`): the payload is
 * `{kind, action, ref}`, `kind` and `action` select from closed string tables
 * compiled into the page, and `ref` is matched against an opaque pattern.
 *
 * Reading that file's tables here means a change to the worker's vocabulary
 * fails this suite at the commit that makes it, instead of showing up as a
 * lock screen that says the wrong thing.
 */

const pushSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../apps/pages/src/lib/push.ts",
  ),
  "utf8",
);

/** The keys of `const <name> = new Map<string, string>(Object.entries({ … }))`. */
function tableKeys(name: string): string[] {
  const start = pushSource.indexOf(`const ${name} = new Map`);
  const end = pushSource.indexOf("}),", start);
  expect(start).toBeGreaterThanOrEqual(0);
  return [...pushSource.slice(start, end).matchAll(/^\s+(\w+):/gmu)].map(
    ([, key = ""]) => key,
  );
}

describe("Web Push payload against the service worker's tables", () => {
  const push = createWebPushAdapter({
    vapidPublicKey: "",
    vapidPrivateKey: "",
    vapidSubject: "mailto:ops@example.test",
  });

  it("names every notification class the worker has a title for", () => {
    expect(tableKeys("TITLES").sort()).toEqual(
      [...NOTIFICATION_CLASSES].sort(),
    );
  });

  it("selects only bodies the worker has", () => {
    const bodies = new Set(tableKeys("BODIES"));
    for (const notificationClass of NOTIFICATION_CLASSES) {
      const wake = push.render(
        renderInput({ kind: "native_push", notificationClass }),
      ).wake;
      expect(wake?.kind).toBe(notificationClass);
      expect(bodies.has(wake?.action ?? "")).toBe(true);
    }
  });

  it("uses the reference pattern the worker accepts", () => {
    expect(pushSource).toContain("/^[A-Za-z0-9_-]{1,128}$/");
  });
});
