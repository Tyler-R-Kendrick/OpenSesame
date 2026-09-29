import type { LocalApplication } from "@opensesame/app-core/lib/local-applications.js";
import { describe, expect, it } from "vitest";
import {
  reconcileRegistrationDraft,
  registrationDraft,
} from "./registration-draft.js";

const saved: LocalApplication = {
  applicationId: "app",
  organizationId: "org",
  redirectUris: ["https://rp.example.test/callback"],
  scopes: ["openid"],
  scopeRoles: [{ scope: "openid", roles: ["owner", "admin", "member"] }],
  revision: 1,
};

describe("reconcileRegistrationDraft", () => {
  it("adopts a newer registration while the person has not edited", () => {
    const before = registrationDraft(saved);
    const next = registrationDraft({
      ...saved,
      scopes: ["openid", "records:read"],
    });
    expect(reconcileRegistrationDraft(before, before, next)).toBe(next);
  });

  // The CI failure: the person clears the field and starts typing, then the
  // form's first reconcile lands with the very registration it rendered
  // from. The edit must survive — `openid` must not come back into the field.
  it("never puts saved values back over an edit made before the reconcile landed", () => {
    const baseline = registrationDraft(saved);
    const edited = { ...baseline, scopes: "" };
    const same = registrationDraft(saved);
    expect(reconcileRegistrationDraft(edited, baseline, same)).toBe(edited);
  });

  it("keeps an in-progress edit across a quiet reload that changed the record", () => {
    const baseline = registrationDraft(saved);
    const edited = { ...baseline, redirects: "https://rp.example.test/other" };
    const imported = registrationDraft({
      ...saved,
      organizationId: "org-2",
    });
    expect(reconcileRegistrationDraft(edited, baseline, imported)).toBe(edited);
  });

  it("resets an untouched form to defaults after the registration is removed", () => {
    const baseline = registrationDraft(saved);
    const removed = registrationDraft(undefined);
    expect(reconcileRegistrationDraft(baseline, baseline, removed)).toEqual({
      organizationId: "",
      redirects: "",
      scopes: "openid",
      scopeRoles: removed.scopeRoles,
    });
  });

  it("compares scope roles by value, not identity", () => {
    const baseline = registrationDraft(saved);
    const copy = registrationDraft(structuredClone(saved));
    const next = registrationDraft({
      ...saved,
      scopes: ["openid", "x"],
    });
    expect(reconcileRegistrationDraft(copy, baseline, next)).toBe(next);
  });
});
