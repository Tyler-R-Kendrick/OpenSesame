import { loadSession } from "@opensesame/app-core/lib/federation.js";
import type { LocalIdentity } from "@opensesame/app-core/lib/local-directory.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import type { LocalSession } from "@opensesame/app-core/lib/local-sessions.js";
import {
  type SiopSocialProof,
  bindSiopRequest,
} from "@opensesame/app-core/lib/siop-authority.js";
import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";
import {
  clearSiopSocialAttempt,
  readSiopSocialAttempt,
  useSiopSocialChoices,
} from "../../lib/siop-social.js";

function useConsentFields(request: NormalizedAuthorizationRequest) {
  const [people, setPeople] = useState<LocalIdentity[]>([]);
  const [application, setApplication] = useState("");
  const [person, setPerson] = useState("");
  const [session, setSession] = useState<LocalSession | null>(null);
  const [socialProof, setSocialProof] = useState<SiopSocialProof | null>(null);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialError, setSocialError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const socialChoices = useSiopSocialChoices();
  const { search } = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const redirectOrigin = useMemo(() => {
    try {
      return new URL(request.redirectUri).origin;
    } catch {
      return "unknown origin";
    }
  }, [request.redirectUri]);

  return {
    people,
    setPeople,
    application,
    setApplication,
    person,
    setPerson,
    session,
    setSession,
    socialProof,
    setSocialProof,
    socialBusy,
    setSocialBusy,
    socialError,
    setSocialError,
    busy,
    setBusy,
    loaded,
    setLoaded,
    error,
    setError,
    finished,
    setFinished,
    socialChoices,
    search,
    root,
    generation,
    redirectOrigin,
  };
}

export type SiopConsentState = ReturnType<typeof useConsentFields>;

function useSiopRegistration(
  tomb: string,
  request: NormalizedAuthorizationRequest,
  state: SiopConsentState,
): void {
  const { generation, setApplication, setPeople, setLoaded, setError } = state;
  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const bound = await bindSiopRequest(tomb, request);
        const directory = await readLocalDirectory(tomb);
        if (current !== generation.current) return;
        const members = new Set(
          directory.memberships
            .filter(
              (row) => row.organizationId === bound.application.organizationId,
            )
            .map((row) => row.principalId),
        );
        const app = directory.entries.find(
          (row) =>
            row.id === bound.application.applicationId &&
            row.kind === "application" &&
            row.enabled,
        );
        setApplication(app?.name ?? bound.application.applicationId);
        setPeople(
          directory.entries.filter(
            (row) =>
              row.kind === "person" && row.enabled && members.has(row.id),
          ),
        );
        setLoaded(true);
      } catch {
        if (current === generation.current)
          setError(
            "This Self-Issued request is unavailable. Check its registration in Identity, then start again from the application.",
          );
      }
    })();
    return () => {
      generation.current++;
    };
  }, [
    tomb,
    request,
    generation,
    setApplication,
    setPeople,
    setLoaded,
    setError,
  ]);
}

function useSiopSocialReturn(state: SiopConsentState): void {
  const {
    loaded,
    people,
    person,
    search,
    setPerson,
    setSocialError,
    setSocialProof,
  } = state;
  // A hosted identity provider returns to this page with its own session
  // already adopted. The attempt in sessionStorage says which provider and
  // which local person the redirect belonged to; a reload never trusts a
  // stale `social` query by itself.
  useEffect(() => {
    if (!loaded) return;
    const id = new URLSearchParams(search).get("social");
    const attempt = readSiopSocialAttempt(id);
    if (!attempt) return;
    if (attempt.personId !== person) {
      if (people.some((entry) => entry.id === attempt.personId)) {
        setPerson(attempt.personId);
      } else {
        clearSiopSocialAttempt();
        setSocialError(
          "Choose the local person you started social sign-in with.",
        );
      }
      return;
    }
    if (attempt.source !== "identity") return;
    const upstream = loadSession();
    if (
      !upstream ||
      upstream.upstreamId !== attempt.upstreamId ||
      upstream.expiresAt <= Date.now()
    ) {
      clearSiopSocialAttempt();
      setSocialError("That social sign-in expired. Choose it again.");
      return;
    }
    clearSiopSocialAttempt();
    setSocialProof({
      source: "identity",
      providerId: attempt.providerId,
      label: attempt.label,
      personId: attempt.personId,
      at: Date.now(),
      upstreamId: attempt.upstreamId,
    });
  }, [
    loaded,
    people,
    person,
    search,
    setPerson,
    setSocialError,
    setSocialProof,
  ]);
}

export function useSiopConsentState(
  tomb: string,
  request: NormalizedAuthorizationRequest,
): SiopConsentState {
  const state = useConsentFields(request);
  const {
    person,
    socialProof,
    setSocialProof,
    loaded,
    busy,
    socialBusy,
    finished,
    root,
  } = state;
  useSiopRegistration(tomb, request, state);
  useSiopSocialReturn(state);
  useEffect(() => {
    if (socialProof && socialProof.personId !== person) setSocialProof(null);
  }, [person, socialProof, setSocialProof]);

  useEffect(() => {
    if (loaded && !busy && !socialBusy && !finished && keyboardIsIdle())
      landFocus(firstControl(root.current));
  });

  return state;
}
