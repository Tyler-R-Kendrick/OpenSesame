/**
 * VAULT-06 … VAULT-10 — records, scopes and parsers of an installation that
 * excluded most of the optional surface.
 *
 * As with `vault-plane.test.ts`, these run against the real catalog, the real
 * shipped profiles and the real vault: the point of the family is what *this*
 * product does when the capability that owns a record is not there.
 */

import { capabilityFlagKey } from "@opensesame/app-core/lib/capabilities/openfeature.js";
import { itemKindsFrom } from "@opensesame/app-core/lib/item-kinds.js";
import { kvDelete, kvGet } from "@opensesame/app-core/lib/kv.js";
import { fidoCxf } from "@opensesame/app-core/lib/vault/import/formats/cxf.js";
import { summarise } from "@opensesame/app-core/lib/vault/import/index.js";
import {
  agentMayInvokeCryptoAlias,
  assertAgentMayNotUnwrapHumanRoot,
} from "@opensesame/app-core/lib/vault/protection/agent-boundary.js";
import {
  ATTEMPTS_KEY,
  GUEST_TOMB,
  VaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { LEGACY_PREFS_KEY } from "@opensesame/app-core/lib/vault/tomb-migration.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { approved, profilePlan, profileSelection } from "./vault-profiles.js";

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);

async function clearVaultSurface(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
  kvDelete(tombFileKey(GUEST_TOMB, BODY_PATH));
  kvDelete(LEGACY_PREFS_KEY);
}

beforeEach(async () => {
  await clearVaultSurface();
});

/** One foreign passkey, exported by another manager (FIDO CXF). */
function cxfWithPasskey() {
  return {
    fileName: "export.json",
    headers: null,
    bytes: null,
    text: "",
    json: {
      version: 1,
      exporter: "SomeOtherManager",
      timestamp: 1_772_600_767,
      accounts: [
        {
          id: "acct",
          username: "ada",
          email: "ada@example.com",
          collections: [],
          items: [
            {
              id: "p",
              title: "example.org",
              credentials: [
                {
                  type: "passkey",
                  credentialId: "Y3JlZC1pZC0wMDE",
                  rpId: "example.org",
                  username: "ada@example.org",
                  userDisplayName: "Ada",
                  userHandle: "dXNlcg",
                  key: "TUlHSEFnRUFNQk1HQnlxR1NNNDlB", // gitleaks:allow -- truncated PEM header, no key body
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("VAULT-06 — an import that asks for a capability this device lacks", () => {
  it("keeps the record, explains it, and enables nothing", async () => {
    const plan = profilePlan("family-local");
    expect(approved(plan, "vault.passkey-records")).toBe(false);
    expect(approved(plan, "vault.interop-formats")).toBe(false);

    const result = fidoCxf.parse(cxfWithPasskey());
    const drafted = result.items[0];
    expect(drafted?.kind).toBe("passkey");
    // Recoverable and opaque: the record travels, the private key never does,
    // and a foreign authenticator's key is not something this vault holds.
    expect(JSON.stringify(drafted)).not.toContain(
      "TUlHSEFnRUFNQk1HQnlxR1NNNDlB",
    );
    // A bounded explanation, not a silent drop and not a stack trace.
    expect(summarise([...result.items]).passkeys).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const warning of result.warnings)
      expect(warning.length).toBeLessThan(400);

    // Landing it in the vault changes nothing about the plan, and the kinds a
    // person may create here stay the core four.
    const store = new VaultStore();
    await store.create(PASSWORD);
    const record = createItem("passkey", "example.org");
    await store.saveItem(record);
    await store.flushPendingWrites();
    expect(itemKindsFrom([]).map((row) => row.id)).not.toContain("passkey");
    expect(approved(profilePlan("family-local"), "vault.passkey-records")).toBe(
      false,
    );
  });
});

describe("VAULT-07 — switching tombs leaks nothing across them", () => {
  it("a guest beside a sealed vault reads, writes and deletes neither", async () => {
    const personal = new VaultStore();
    await personal.create(PASSWORD);
    const mine = createItem("secret", "household wifi");
    await personal.saveItem(mine);
    await personal.flushPendingWrites();
    const sealedHeader = kvGet(HEADER_KEY);
    const sealedBody = kvGet(BODY_KEY);
    personal.lock();

    const guest = new VaultStore();
    await guest.createGuest();
    expect(guest.activeTomb()).toBe(GUEST_TOMB);
    expect(guest.getSnapshot().guest).toBe(true);
    // Nothing of the personal tomb is visible from here.
    expect(
      guest.getSnapshot().items.some((item) => item.name === "household wifi"),
    ).toBe(false);
    const guestItem = createItem("note", "guest scratch");
    await guest.saveItem(guestItem);
    await guest.flushPendingWrites();

    // And the sealed tomb is byte-identical: not read, not written, not
    // deleted. Isolation is the answer to "a guest would clobber the vault".
    expect(kvGet(HEADER_KEY)).toBe(sealedHeader);
    expect(kvGet(BODY_KEY)).toBe(sealedBody);

    const back = new VaultStore();
    await back.unlock(PASSWORD);
    expect(back.getSnapshot().items.map((item) => item.name)).toEqual([
      "household wifi",
    ]);
  });
});

describe("VAULT-08 — a flag that claims permission still cannot reach the root", () => {
  it("refuses agent root unwrap, and a projected flag is not an input to it", () => {
    // A provider could answer true for anything; the projection is a read of
    // the plan, and the plan is not what these fences consult.
    const plan = profilePlan("family-local");
    expect(capabilityFlagKey("agents.webmcp")).toContain("agents.webmcp");
    expect(approved(plan, "agents.webmcp")).toBe(false);

    for (const alias of [
      "Decrypt",
      "kms:Decrypt",
      "opensesame.vault.unwrap_root",
    ]) {
      expect(
        agentMayInvokeCryptoAlias({ alias, purpose: "human-vault-root" }),
      ).toBe(false);
      expect(() =>
        assertAgentMayNotUnwrapHumanRoot({
          alias,
          purpose: "human-vault-root",
        }),
      ).toThrow(/not available through ConnectionRef/);
    }
    // A generic alias with no declared domain is the oracle surface, and it
    // is refused without asking anything about the caller's claims.
    expect(
      agentMayInvokeCryptoAlias({ alias: "unwrap", purpose: "workload-root" }),
    ).toBe(false);
  });
});

describe("VAULT-09 — a malformed import is bounded and starts nothing else", () => {
  it("refuses the document it was handed without reaching for another parser", () => {
    // The adapter it was handed, on a document of the wrong shape: it says no
    // rather than throwing the tab away, and it does not hand the bytes on.
    const malformed = {
      fileName: "export.json",
      headers: null,
      bytes: null,
      text: "",
      json: { version: 1, accounts: "not-a-list" },
    };
    expect(fidoCxf.detect(malformed)).toBe(false);
    const result = fidoCxf.parse(malformed);
    expect(result.items).toEqual([]);
    expect(result.warnings.length).toBeLessThan(20);

    // Deep nesting is answered by the same bound, not by recursion.
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1)
      nested = { accounts: nested };
    expect(() =>
      fidoCxf.parse({
        fileName: "export.json",
        headers: null,
        bytes: null,
        text: "",
        // SAFETY: deliberately malformed input for this contract.
        json: nested as never,
      }),
    ).not.toThrow(RangeError);
  });
});

describe("VAULT-10 — household sharing runs only its chosen transport", () => {
  it("is a conflict without one, not a capability that quietly half-works", () => {
    const withTransport = profilePlan("family-sharing-selected");
    expect(approved(withTransport, "sharing.household")).toBe(true);
    expect(approved(withTransport, "sharing.drops")).toBe(true);
    expect(withTransport.conflicts).toEqual([]);

    // The same root with no transport chosen: the slot is unsatisfied, and an
    // unsatisfied alternative is reported rather than approved. Nothing may
    // report household sharing as working with no road for it to travel.
    const base = profileSelection("family-sharing-selected");
    const alone = profilePlan("family-sharing-selected", {
      installation: {
        ...base,
        selectedOptional: ["sharing.household"],
        chosenAlternatives: {},
        revision: "household-alone",
      },
    });
    expect(approved(alone, "sharing.drops")).toBe(false);
    expect(approved(alone, "sharing.household")).toBe(false);
    expect(alone.conflicts).toEqual([
      {
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: "sharing.household",
        subject: "transport",
        message: "`sharing.household` needs a choice for slot `transport`",
      },
    ]);
    // The reason is on the capability too, so a surface reading the plan says
    // "a transport is missing" rather than drawing sharing as if it ran.
    expect(alone.capabilities["sharing.household"]?.reasons).toContain(
      "ALTERNATIVE_NOT_CHOSEN",
    );
  });
});
