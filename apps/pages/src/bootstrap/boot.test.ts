import {
  peekApprovalArrival,
  resetApprovalArrivalForTests,
} from "@opensesame/app-core/lib/approvals-link.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  compositionStore,
  storeSeams,
} from "@opensesame/app-core/lib/capabilities/store.js";
import {
  peekClaimArrival,
  resetClaimArrivalForTests,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { takeDeviceArrival } from "@opensesame/app-core/lib/device-link.js";
import {
  peekInteractionArrival,
  resetInteractionArrivalForTests,
} from "@opensesame/app-core/lib/interactions-link.js";
import { kvDelete, kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import { LAST_VAULT_KEY } from "@opensesame/app-core/lib/last-vault.js";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { distributionFromOwnership } from "../lib/capabilities/ownership.js";
import { bootCore } from "./boot.js";

import { PROJECTS_KEY } from "@opensesame/app-core/lib/projects.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  LEGACY_BODY_KEY,
  LEGACY_HEADER_KEY,
} from "@opensesame/app-core/lib/vault/tomb-migration.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  lockAllTombs,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "@opensesame/app-core/lib/vfs.js";

/**
 * Boot-path boundary (ADR 0063): before unlock the app may read only the
 * documented plaintext surface — boot endpoints (`settings.v1`), the vault
 * header (public params), lockout counters, and tomb names — plus sealed
 * ciphertext it cannot open (the body). The sealed VFS (config, index,
 * drops) stays untouched until a key exists.
 */

const touched = vi.hoisted(() => ({ keys: new Set<string>(), crypto: 0 }));

/**
 * What the boot asked to pull out of durable storage.
 *
 * jsdom has no OPFS, so `kvHydrate` is a no-op here and memory already holds
 * everything a test wrote — which means no assertion about the *store* can
 * tell a boot that hydrates the guest tomb from one that does not. The
 * request is the observable, so it is recorded.
 */
const hydrated = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("@opensesame/app-core/lib/kv.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@opensesame/app-core/lib/kv.js")>();
  return {
    ...actual,
    kvHydrate: async (keys: readonly string[]) => {
      hydrated.keys.push(...keys);
      return actual.kvHydrate([...keys]);
    },
  };
});

const originalVfsSeams = { ...vfsSeams };
Object.assign(vfsSeams, {
  readRaw: (key: string): string | null => {
    touched.keys.add(key);
    return originalVfsSeams.readRaw(key);
  },
  writeRaw: async (key: string, value: string): Promise<void> => {
    touched.keys.add(key);
    return originalVfsSeams.writeRaw(key, value);
  },
  seal: async (...args: Parameters<typeof originalVfsSeams.seal>) => {
    touched.crypto += 1;
    return originalVfsSeams.seal(...args);
  },
  open: async (...args: Parameters<typeof originalVfsSeams.open>) => {
    touched.crypto += 1;
    return originalVfsSeams.open(...args);
  },
});

const SEALED_VFS_RE = /^tomb\/[^/]+\/(config|drops)\//;

function clearBootKeys(): void {
  for (const key of [
    PROJECTS_KEY,
    TOMBS_REGISTRY_KEY,
    "settings.v1",
    LAST_VAULT_KEY,
    LEGACY_HEADER_KEY,
    LEGACY_BODY_KEY,
    tombFileKey(PERSONAL_TOMB, HEADER_PATH),
    tombFileKey(PERSONAL_TOMB, BODY_PATH),
    tombFileKey(PERSONAL_TOMB, INDEX_PATH),
    tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH),
  ]) {
    kvDelete(key);
  }
}

beforeEach(() => {
  // `virtual:opensesame-distribution` is emitted by the build plugin, which
  // does not run under vitest; the seam is the supported way in. The catalog
  // is the real one — the point of calling the shipped boot is that nothing
  // about it is a stand-in except what the build alone can provide.
  storeSeams.catalog = async () => CAPABILITY_CATALOG;
  storeSeams.distribution = async () => distributionFromOwnership("selective");
  storeSeams.locks = () => undefined;
  hydrated.keys = [];
  compositionStore.resetForTest();
});

afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  clearBootKeys();
  touched.keys.clear();
  touched.crypto = 0;
});

/**
 * The shipped boot sequence, up to (not including) first paint.
 *
 * Called, not mirrored: this used to re-implement `main.tsx`'s body here, so
 * it proved what the test did rather than what the app does — and the app's
 * body has since moved into `bootCore` (ownership.md §3). A copy would have
 * gone on passing while the shipped path dropped a step.
 */
async function boot(): Promise<void> {
  const { stopWatching } = await bootCore();
  stopWatching();
}

describe("pre-unlock boot path", () => {
  it("reads only the plaintext boundary — no sealed VFS access", async () => {
    kvSet("settings.v1", JSON.stringify({ hostApi: "http://127.0.0.1:18787" }));
    kvSet(LEGACY_HEADER_KEY, '{"v":1,"createdAt":"2026-08-29T00:00:00Z"}');
    kvSet(LEGACY_BODY_KEY, '{"ivB64":"AAAA","ctB64":"BBBB"}');

    await boot();

    // The legacy vault migrated: the store now sees a locked personal tomb.
    expect(vaultStore.getSnapshot().status).toBe("locked");
    expect(kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH))).toContain('"v":1');

    // Nothing under config/, drops/, or the index was read or written, and
    // not a single seal/open ran — there is no key before unlock.
    for (const key of touched.keys) {
      expect(key).not.toMatch(SEALED_VFS_RE);
      expect(key).not.toMatch(/^tomb\/[^/]+\/index$/);
    }
    expect(touched.crypto).toBe(0);

    // Every key the boot path did touch is inside the documented plaintext
    // boundary: tomb names, the header (public params), the sealed body
    // ciphertext, the migration marker, and legacy flat keys being moved.
    // (Boot endpoints in `settings.v1` hydrate through the kv layer and
    // never pass through the VFS at all.)
    const PLAINTEXT_BOUNDARY_RE =
      /^(projects\.v1|tombs\.v1|vault\.[a-z]+\.v1|site-broker\.[a-z]+\.v1|tomb\/[^/]+\/(header|body|migrated\.v1))$/;
    for (const key of touched.keys) {
      expect(key).toMatch(PLAINTEXT_BOUNDARY_RE);
    }
    // The header WAS read — it is the one vault file the lock screen needs.
    expect(
      touched.keys.has(tombFileKey(PERSONAL_TOMB, HEADER_PATH)) ||
        touched.keys.has(LEGACY_HEADER_KEY),
    ).toBe(true);
  });

  it("opens guest unlock when last-vault was guest (install-return reload)", async () => {
    // Full navigation away (GitHub App install) and back is a cold boot: the
    // last-vault pointer must hydrate before rehydrate or unlock defaults to
    // personal even though the guest was the last authorized account.
    kvSet(LAST_VAULT_KEY, GUEST_TOMB);
    kvSet(LEGACY_HEADER_KEY, '{"v":1,"createdAt":"2026-08-29T00:00:00Z"}');

    await boot();

    expect(vaultStore.getSnapshot().tomb).toBe(GUEST_TOMB);
    expect(vaultStore.getSnapshot().status).toBe("empty");
  });

  it("pulls the guest tomb out of storage when it is the account to ask about", async () => {
    // The tomb the unlock screen will ask about is the guest tomb when that
    // was the last authorized account (AGENTS.md §5). Hydrating only the
    // active project left a guest's enrolled gate unreadable on reload, and
    // the unlock form then offered a road with no challenge behind it (#467).
    kvSet(LAST_VAULT_KEY, GUEST_TOMB);
    await boot();
    expect(hydrated.keys).toEqual(
      expect.arrayContaining([tombFileKey(GUEST_TOMB, HEADER_PATH)]),
    );

    // And it does not pull a tomb it has no reason to ask about.
    hydrated.keys = [];
    kvDelete(LAST_VAULT_KEY);
    await boot();
    expect(hydrated.keys).not.toContain(tombFileKey(GUEST_TOMB, HEADER_PATH));
  });

  it("asks for the gate a guest enrolled, from a cold boot (ADR 0091)", async () => {
    // A guest may enroll a PIN and an authenticator code. Both wraps live in
    // the guest tomb's header on disk, so a cold boot has to hydrate that tomb
    // and ask for them — the reload leg of `verify:auth` depends on it.
    kvSet(LAST_VAULT_KEY, GUEST_TOMB);
    kvSet(
      tombFileKey(GUEST_TOMB, HEADER_PATH),
      JSON.stringify({
        v: 1,
        createdAt: "2026-08-29T00:00:00Z",
        unlocks: { pin: { saltB64: "AA", wrapB64: "BB" }, totp: {} },
      }),
    );

    await boot();

    const snap = vaultStore.getSnapshot();
    expect(snap.tomb).toBe(GUEST_TOMB);
    expect(snap.status).toBe("locked");
    expect(snap.header?.unlocks?.pin).toBeTruthy();
    expect(snap.header?.unlocks?.totp).toBeTruthy();
  });

  it("takes a device link out of the address before the first paint", async () => {
    history.replaceState(null, "", "/?user_code=abcd-efgh&claim_id=clm_1");
    await boot();
    expect(`${location.pathname}${location.search}`).toBe("/device");
    expect(takeDeviceArrival()).toEqual({
      kind: "code",
      userCode: "ABCD-EFGH",
    });
    // A sign-in callback's `?code=` is the router's, never a user code.
    history.replaceState(null, "", "/?code=abc&state=xyz");
    await boot();
    expect(location.search).toBe("?code=abc&state=xyz");
    expect(takeDeviceArrival()).toEqual({ kind: "none" });
    history.replaceState(null, "", "/");
  });

  it("takes a claim or drop link out of the address before the first paint", async () => {
    history.replaceState(null, "", "/claim#token=osc_clm_pub.secret&key=a2V5"); // gitleaks:allow -- synthetic claim-shaped test vector
    await boot();
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      "/claim",
    );
    expect(peekClaimArrival()).toEqual({
      kind: "drop",
      token: "osc_clm_pub.secret",
      key: "a2V5",
    });
    resetClaimArrivalForTests();
    // Another path's fragment is not the claim route's to read.
    history.replaceState(null, "", "/join#token=osc_clm_pub.secret");
    await boot();
    expect(location.hash).toBe("#token=osc_clm_pub.secret");
    expect(peekClaimArrival()).toEqual({ kind: "none" });
    history.replaceState(null, "", "/");
  });

  it("takes an /i/<ref> link's fragment and credential query out before the first paint", async () => {
    const ref = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
    history.replaceState(null, "", `/i/${ref}#state=abc`);
    await boot();
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      `/i/${ref}`,
    );
    expect(peekInteractionArrival()).toEqual({ kind: "interaction", ref });
    history.replaceState(null, "", `/i/${ref}?access_token=leaked`);
    await boot();
    expect(location.href).not.toContain("leaked");
    expect(peekInteractionArrival()).toEqual({ kind: "refused" });
    resetInteractionArrivalForTests();
    history.replaceState(null, "", "/");
  });

  it("takes an /approve/<ref> link's query and fragment out before the first paint", async () => {
    history.replaceState(null, "", "/approve/areq_abc?utm=chat#x");
    await boot();
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      "/approve/areq_abc",
    );
    expect(peekApprovalArrival()).toEqual({ kind: "request", ref: "areq_abc" });
    history.replaceState(null, "", "/approve/areq_abc#id_token=leaked");
    await boot();
    expect(location.href).not.toContain("leaked");
    expect(peekApprovalArrival()).toEqual({ kind: "refused" });
    resetApprovalArrivalForTests();
    history.replaceState(null, "", "/");
  });
});
