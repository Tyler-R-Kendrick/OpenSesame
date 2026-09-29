import {
  type LocalScopeRoles,
  defaultScopeRoles,
} from "@opensesame/app-core/lib/local-application-policy.js";
import type { LocalApplication } from "@opensesame/app-core/lib/local-applications.js";
import { useEffect, useRef, useState } from "react";

/** What the registration form edits: the saved record, as form fields. */
export interface RegistrationDraft {
  organizationId: string;
  redirects: string;
  scopes: string;
  scopeRoles: LocalScopeRoles[];
}

export function registrationDraft(
  saved: LocalApplication | undefined,
): RegistrationDraft {
  return {
    organizationId: saved?.organizationId ?? "",
    redirects: saved?.redirectUris.join("\n") ?? "",
    scopes: saved?.scopes.join(" ") ?? "openid",
    scopeRoles:
      saved?.scopeRoles ?? defaultScopeRoles(saved?.scopes ?? ["openid"]),
  };
}

function sameDraft(a: RegistrationDraft, b: RegistrationDraft): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.redirects === b.redirects &&
    a.scopes === b.scopes &&
    JSON.stringify(a.scopeRoles) === JSON.stringify(b.scopeRoles)
  );
}

/**
 * The draft to show once the saved registration changes from `baseline` to
 * `next`. An untouched draft follows the record; an edited one is kept.
 *
 * Keeping the edit is safe: a save is checked against the revision it was
 * read at, so an edit made over an older record is refused, not written over
 * the newer one. Dropping it silently is not — the form used to reset on
 * every read, so a read that landed after the person started typing put the
 * old values back under their cursor.
 */
export function reconcileRegistrationDraft(
  current: RegistrationDraft,
  baseline: RegistrationDraft,
  next: RegistrationDraft,
): RegistrationDraft {
  return sameDraft(current, baseline) ? next : current;
}

/**
 * The form's draft of `saved`, reconciled — never reset — when a read brings
 * a different record: see {@link reconcileRegistrationDraft}.
 */
export function useRegistrationDraft(saved: LocalApplication | undefined) {
  const [draft, setDraft] = useState(() => registrationDraft(saved));
  const baseline = useRef(draft);
  useEffect(() => {
    const next = registrationDraft(saved);
    const previous = baseline.current;
    baseline.current = next;
    setDraft((current) => reconcileRegistrationDraft(current, previous, next));
  }, [saved]);
  return [draft, setDraft] as const;
}
