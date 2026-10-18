import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import { featureOf } from "../capabilities/features.js";
import { settingsPath } from "../crumbs.js";
import {
  LEGACY_IDENTITY_CAPABILITIES,
  LEGACY_IDENTITY_FEATURES_PATH,
  LEGACY_IDENTITY_SAVE_FAILURE,
  LEGACY_IDENTITY_TITLES,
  type LegacyIdentityNoticeDecision,
  legacyIdentityNotice,
  legacyIdentityTurnOffProposal,
  raiseLegacyIdentityNotice,
  resetLegacyIdentityNoticeForTest,
} from "./legacy-identity-notice.js";
import { normalizeVaultPrefs } from "./prefs.js";

const FRESH_INSTALL = [
  "access.authority",
  "connectors.external",
  "identity.federation",
  "identity.local-iam",
  "vault.certificate-records",
  "vault.derived-records",
  "vault.passkey-records",
];

function unlocked(approved: readonly string[], seen: boolean) {
  return {
    status: "unlocked",
    guest: false,
    tomb: "personal",
    seen,
    ready: true,
    approved,
  };
}

describe("legacy identity notice", () => {
  const announced: LegacyIdentityNoticeDecision[] = [];
  let marks = 0;
  const failures: string[] = [];

  const ports = {
    markSeen: () => {
      marks += 1;
      return Promise.resolve();
    },
    announce: (notice: LegacyIdentityNoticeDecision) => {
      announced.push(notice);
    },
    fail: (message: string) => {
      failures.push(message);
    },
  };

  beforeEach(() => {
    announced.length = 0;
    marks = 0;
    failures.length = 0;
    resetLegacyIdentityNoticeForTest();
  });

  it("shows once when enabled", () => {
    raiseLegacyIdentityNotice(
      unlocked(["identity.local-iam", "identity.siop"], false),
      ports,
    );
    expect(announced).toHaveLength(1);
    expect(marks).toBe(1);
    const notice = announced[0];
    expect(notice?.title).toBe("Identity");
    expect(notice?.body).toBe(
      "Self-issued OpenID is on. Turn it off in Settings › Features.",
    );
    expect(notice?.enabled).toEqual(["identity.siop"]);
    expect(notice?.open.to).toBe(settingsPath("features", "feature-identity"));
    expect(notice?.open.to).toBe(LEGACY_IDENTITY_FEATURES_PATH);
    expect(notice?.tone).toBe("info");

    raiseLegacyIdentityNotice(
      unlocked(["identity.local-iam", "identity.siop"], false),
      ports,
    );
    expect(announced).toHaveLength(1);
    expect(marks).toBe(1);
  });

  it("names both tiles when both are approved", () => {
    const notice = legacyIdentityNotice({
      approved: ["identity.siop", "identity.ambient-sso"],
      seen: false,
    });
    expect(notice?.body).toBe(
      "Self-issued OpenID and Ambient single sign-on are on. Turn them off in Settings › Features.",
    );
    expect(notice?.enabled).toEqual(["identity.siop", "identity.ambient-sso"]);
  });

  it("does not show when off", () => {
    raiseLegacyIdentityNotice(unlocked(FRESH_INSTALL, false), ports);
    raiseLegacyIdentityNotice(unlocked([], false), ports);
    raiseLegacyIdentityNotice(
      unlocked(["identity.federation", "identity.local-iam"], false),
      ports,
    );
    expect(announced).toEqual([]);
    expect(marks).toBe(0);
    expect(
      legacyIdentityNotice({
        approved: ["identity.siop"],
        seen: false,
      }),
    ).not.toBeNull();
  });

  it("does not show twice", () => {
    raiseLegacyIdentityNotice(
      unlocked(["identity.siop", "identity.ambient-sso"], true),
      ports,
    );
    expect(announced).toEqual([]);
    expect(marks).toBe(0);
    expect(
      legacyIdentityNotice({
        approved: ["identity.ambient-sso"],
        seen: true,
      }),
    ).toBeNull();
  });

  it("does not show before the plan is ready or for a guest", () => {
    raiseLegacyIdentityNotice(
      { ...unlocked(["identity.siop"], false), ready: false },
      ports,
    );
    raiseLegacyIdentityNotice(
      { ...unlocked(["identity.siop"], false), guest: true, tomb: "guest" },
      ports,
    );
    raiseLegacyIdentityNotice(
      { ...unlocked(["identity.siop"], false), status: "locked" },
      ports,
    );
    expect(announced).toEqual([]);
    expect(marks).toBe(0);
  });

  it("reports a tray failure when the sealed marker cannot be saved", async () => {
    raiseLegacyIdentityNotice(unlocked(["identity.ambient-sso"], false), {
      ...ports,
      markSeen: () => Promise.reject(new Error("disk")),
    });
    expect(announced).toHaveLength(1);
    await Promise.resolve();
    expect(failures).toEqual([LEGACY_IDENTITY_SAVE_FAILURE]);
  });

  it("uses the Features catalog titles and the Identity section", () => {
    for (const id of LEGACY_IDENTITY_CAPABILITIES) {
      expect(
        CAPABILITY_CATALOG.capabilities.find((entry) => entry.id === id)?.title,
      ).toBe(LEGACY_IDENTITY_TITLES[id]);
      expect(featureOf(id)?.id).toBe("identity");
    }
  });

  it("turns the approved capabilities off without touching the rest", () => {
    const next = legacyIdentityTurnOffProposal(
      {
        roots: [
          "identity.local-iam",
          "identity.siop",
          "identity.ambient-sso",
          "identity.federation",
        ],
        alternatives: {},
      },
      ["identity.siop"],
      null,
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual([
      "identity.local-iam",
      "identity.ambient-sso",
      "identity.federation",
    ]);
    const both = legacyIdentityTurnOffProposal(
      next,
      ["identity.ambient-sso"],
      null,
      CAPABILITY_CATALOG,
    );
    expect(both.roots).toEqual(["identity.local-iam", "identity.federation"]);
  });

  it("keeps the sealed marker and does not invent one", () => {
    expect(
      normalizeVaultPrefs({ legacyIdentityNoticeSeen: true })
        .legacyIdentityNoticeSeen,
    ).toBe(true);
    expect(normalizeVaultPrefs(null).legacyIdentityNoticeSeen).toBeUndefined();
    expect(
      normalizeVaultPrefs({
        legacyIdentityNoticeSeen: overlapCast("yes"),
      }).legacyIdentityNoticeSeen,
    ).toBeUndefined();
  });
});
