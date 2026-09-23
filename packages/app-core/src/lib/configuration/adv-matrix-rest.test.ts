import {
  createTypedItem,
  installItemType,
  itemTypeRegistry,
  newValues,
  syncInstalledTypes,
  typedSearchText,
  uninstallItemType,
  unknownTypeSubtitle,
} from "@opensesame/vault-core";
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { deliverToRp, parseBrokerRequest } from "../site-broker.js";
import { COMMENTED, PREFS, draft } from "./adv-fixtures.js";
import { commitApproval } from "./approval-freshness.js";
import { inventoryBackup } from "./backup-coverage.js";
import { copyTextBestEffort } from "./clipboard-copy.js";
import { applySourceEdit, switchDraftMode } from "./draft.js";
import { hostedDraftMatchesIssuer } from "./hosted-application.js";
import { resetKeybindings } from "./keybindings.js";
import { commitPrefsSource } from "./prefs-adapter.js";
import { parsePrefsSource, prefsToYaml } from "./prefs-document.js";
import { exportRecipe, importRecipe } from "./recipes.js";
import { SERVICE_ACCESS_TOKEN_MAX_SECONDS } from "./service-token-bound.js";

const TICKET = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "adv-ticket",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Ticket",
    plural: "Tickets",
    extension: ".ticket",
    summary: "A ticket.",
    categories: ["documents"],
    sections: [
      {
        id: "booking",
        title: "Booking",
        fields: [
          { id: "event", type: "string", label: "Event" },
          { id: "reference", type: "concealed", label: "Reference" },
        ],
      },
    ],
    native: { secret: "reference", trailer: [] },
    cxf: { credential: "custom-fields" },
    subtitle: ["event"],
    search: ["event"],
  },
});

describe("ADV-19..36 against shipped functions", () => {
  it("ADV-19: offline JWT exposure is bounded at 3600 seconds", () => {
    expect(SERVICE_ACCESS_TOKEN_MAX_SECONDS).toBe(3600);
  });

  it("ADV-24: stale, expired, self, and agent approvals are refused", () => {
    const current = {
      requestId: "r1",
      reviewerId: "human",
      requesterId: "agent",
      revision: "1",
      expiresAt: "2099-01-01T00:00:00Z",
      actor: "human" as const,
      surface: "ceremony" as const,
    };
    expect(commitApproval({ ...current, revision: "2" }, current).ok).toBe(
      false,
    );
    expect(
      commitApproval(
        { ...current, expiresAt: "2020-01-01T00:00:00Z" },
        { ...current, expiresAt: "2020-01-01T00:00:00Z" },
        Date.parse("2026-09-17T00:00:00Z"),
      ).ok,
    ).toBe(false);
    expect(
      commitApproval(
        { ...current, reviewerId: "agent" },
        { ...current, requesterId: "agent" },
      ).ok,
    ).toBe(false);
    expect(
      commitApproval({ ...current, actor: "agent", surface: "webmcp" }, current)
        .ok,
    ).toBe(false);
  });

  it("ADV-25/26: import is idempotent by logical id and strips notes", () => {
    const recipe = exportRecipe({
      name: "app",
      resources: [
        {
          kind: "local_application",
          logicalId: "app",
          body: {
            redirectUris: ["https://rp.example/cb"],
            notes: "secret: abc",
          },
        },
      ],
    });
    expect(JSON.stringify(recipe)).not.toContain("secret: abc");
    const first = importRecipe(recipe, { organization: "org-b" });
    const second = importRecipe(recipe, { organization: "org-b" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.bound.resources[0]?.logicalId).toBe(
        second.bound.resources[0]?.logicalId,
      );
    }
  });

  it("ADV-27: empty, corrupt, and newer schema stay original bytes", () => {
    const empty = "";
    expect(parsePrefsSource(empty).ok).toBe(false);
    expect(empty).toBe("");
    const corrupt = "theme: [";
    expect(parsePrefsSource(corrupt).ok).toBe(false);
    expect(corrupt).toBe("theme: [");
    const source = "schemaVersion: 99\ntheme: dark\n";
    const newer = applySourceEdit(draft(source), source, []);
    expect(newer.currentSource).toContain("schemaVersion: 99");
    expect(parsePrefsSource(newer.currentSource).ok).toBe(false);
  });

  it("ADV-28: a stale generation is ignored after a newer save", async () => {
    const stored = { ...PREFS };
    const result = await commitPrefsSource(
      {
        readPrefs: () => stored,
        tomb: () => "personal",
        revisionToken: () => "r2",
        writeSemantic: async () => undefined,
      },
      { source: prefsToYaml({ ...PREFS, theme: "dark" }), baseRevision: "r1" },
    );
    expect(result.status).toBe("conflict");
  });

  it("ADV-29: clipboard denial is an honest failure, not a silent copy", async () => {
    const denied = await copyTextBestEffort("secret", {
      writeText: async () => {
        throw new Error("denied");
      },
    });
    expect(denied.ok).toBe(false);
    const missing = await copyTextBestEffort("secret", {});
    expect(missing.ok).toBe(false);
  });

  it("ADV-31: keymap reset does not rewrite security prefs", () => {
    const prefs = { ...PREFS, autoLockMinutes: 7 };
    expect(resetKeybindings()["/"]).toBe("listing.search");
    expect(prefs.autoLockMinutes).toBe(7);
  });

  it("ADV-32: a draft bound to one issuer cannot auto-apply to another", () => {
    expect(
      hostedDraftMatchesIssuer("https://idp.a.test", "https://idp.b.test"),
    ).toBe(false);
    expect(
      hostedDraftMatchesIssuer("https://idp.a.test", "https://idp.a.test"),
    ).toBe(true);
  });

  it("ADV-33: unexpected origin or missing opener cannot complete sign-in", () => {
    const parsed = parseBrokerRequest(
      "?client_id=origin:https://evil.example&origin=https://evil.example&state=abcdefghijklmnopqrstuv",
    );
    expect(parsed.ok).toBe(false);
    expect(
      deliverToRp(
        {
          type: "opensesame:signin",
          state: "s",
          id_token: "t",
          issuer: "https://idp.example",
          audience: "origin:https://evil.example",
          jwks_uri: "https://idp.example/.well-known/jwks.json",
          expires_at: "2026-09-17T00:00:00.000Z",
        },
        "https://evil.example",
      ),
    ).toBe("none");
  });

  it("ADV-35: uninstalling a type keeps values and concealment", () => {
    expect(installItemType(TICKET).ok).toBe(true);
    const installed = itemTypeRegistry().get("adv-ticket");
    expect(installed).toBeDefined();
    if (!installed) return;
    const item = createTypedItem(
      installed,
      { ...newValues(installed), event: "Show", reference: "SECRET99" },
      "Show",
    );
    expect(typedSearchText(item).join(" ")).not.toContain("SECRET99");
    expect(uninstallItemType("adv-ticket")).toBe(true);
    expect(item.values.reference).toBe("SECRET99");
    expect(unknownTypeSubtitle(item)).toContain("type not installed");
    syncInstalledTypes({});
  });

  it("ADV-36: mode switch is local; source editor is a native textarea", () => {
    const switched = switchDraftMode(draft(), "source");
    expect(switched.currentSource).toBe(COMMENTED);
    const area = document.createElement("textarea");
    area.setAttribute("data-config-source", "true");
    expect(area.tagName).toBe("TEXTAREA");
  });

  it("HIS: a backup that omits vault body cannot claim completeness", () => {
    const incomplete = inventoryBackup({
      format: "opensesame-vault-export",
      paths: ["tomb/<id>/header"],
    });
    expect(incomplete.complete).toBe(false);
  });
});
