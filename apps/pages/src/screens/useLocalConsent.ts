import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import { useEffect, useRef, useState } from "react";
import { readLocalApplications } from "../lib/local-applications.js";
import {
  LocalDirectoryError,
  type LocalIdentity,
  readLocalDirectory,
} from "../lib/local-directory.js";
import {
  LocalIssuerChannel,
  type LocalIssuerStatus,
} from "../lib/local-issuer-channel.js";
import {
  type LocalSession,
  signInLocalIdentity,
} from "../lib/local-sessions.js";

export function useLocalConsent(
  tomb: string,
  request: LocalAuthorizationRequest,
) {
  const [people, setPeople] = useState<LocalIdentity[]>([]);
  const [application, setApplication] = useState("");
  const [agent, setAgent] = useState<LocalIdentity | null>(null);
  const [person, setPerson] = useState("");
  const [session, setSession] = useState<LocalSession | null>(null);
  const [status, setStatus] = useState<LocalIssuerStatus>("waiting");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const channel = useRef<LocalIssuerChannel | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let issuer: LocalIssuerChannel | null = null;
    async function load() {
      try {
        issuer = new LocalIssuerChannel(tomb, request, (next) => {
          if (current === generation.current) setStatus(next);
        });
        channel.current = issuer;
        const data = await readConsentApplication(tomb, request);
        if (current !== generation.current) return;
        setPeople(data.people);
        setApplication(data.name);
        setAgent(data.agent);
        setLoaded(true);
      } catch {
        if (current === generation.current) {
          setError(
            "This application request is unavailable. Check its registration in Identity, then start again from the application.",
          );
          issuer?.close();
        }
      }
    }
    void load();
    return () => {
      generation.current++;
      issuer?.close();
      channel.current = null;
    };
  }, [tomb, request]);

  async function run(approve: boolean) {
    if (busy || status !== "connected" || !channel.current || !person) return;
    const current = generation.current;
    const issuer = channel.current;
    setBusy(true);
    setError("");
    try {
      if (approve) {
        if (session) {
          if (request.agent) await issuer.approveAgent(session);
          else await issuer.approve(session);
        }
      } else {
        const identity = await signInLocalIdentity(tomb, person);
        await issuer.inspectApproval(identity);
        if (current === generation.current) setSession(identity);
      }
    } catch (failure) {
      if (current === generation.current) {
        setSession(null);
        setError(
          failure instanceof LocalDirectoryError
            ? failure.message
            : "Sign-in was not completed. Retry with your enrolled passkey.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return {
    people,
    application,
    agent,
    agentKeyId: request.agent?.keyId,
    person,
    setPerson,
    session,
    status,
    busy,
    loaded,
    error,
    run,
    close: () => channel.current?.close(),
  };
}

async function readConsentApplication(
  tomb: string,
  request: LocalAuthorizationRequest,
) {
  const directory = await readLocalDirectory(tomb);
  const registrations = await readLocalApplications(tomb);
  const app = directory.entries.find(
    (row) =>
      row.id === request.applicationId &&
      row.kind === "application" &&
      row.enabled,
  );
  const registration = registrations.applications.find(
    (row) => row.applicationId === app?.id,
  );
  if (
    !app ||
    !registration ||
    !registration.redirectUris.includes(request.redirectUri) ||
    !request.scopes.every((scope) => registration.scopes.includes(scope))
  )
    throw new Error("invalid_application");
  const members = new Set(
    directory.memberships
      .filter(
        (row) =>
          row.organizationId === registration.organizationId &&
          (!request.agent || row.role === "owner" || row.role === "admin"),
      )
      .map((row) => row.principalId),
  );
  const agent = request.agent
    ? directory.entries.find(
        (row) =>
          row.id === request.agent?.principalId &&
          row.kind === "agent" &&
          row.enabled,
      )
    : null;
  if (request.agent && !agent) throw new Error("invalid_agent");
  return {
    name: app.name,
    agent: agent ?? null,
    people: directory.entries.filter(
      (row) => row.kind === "person" && row.enabled && members.has(row.id),
    ),
  };
}
