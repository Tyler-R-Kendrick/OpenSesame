/**
 * Identity › Organizations' sign-in panels (ADR 0140 plan step 12): for an
 * organization this session owns, the upstream its people sign in through,
 * the email domains that route to it, and the provisioning tokens its
 * directory pushes with. It replaces `apps/console`'s `/organization` page,
 * over app-core's `lib/org-signin.ts`.
 *
 * `enterprise.directory-provisioning` hands this to the Identity section
 * through `directory-panel-slot.ts`; the always-on section never imports it.
 *
 * Gated on what it needs (ADR 0090): a configured Identity API and a
 * session. With either missing it draws nothing and names no service. A
 * member who is not an owner is told so by a glyph on the panel head, and
 * nothing is asked of the Identity API for them.
 */

import { subscribeIdentitySession } from "@opensesame/app-core/lib/identity.js";
import {
  type OrgSignInOrganization,
  orgSignInClient,
  orgSignInOffered,
} from "@opensesame/app-core/lib/org-signin.js";
import { subscribeSettings } from "@opensesame/app-core/lib/settings.js";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ReloadKey } from "../../../components/IconKey.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { DomainsPanel } from "./DomainsPanel.js";
import { TokensPanel } from "./TokensPanel.js";
import { UpstreamPanel } from "./UpstreamPanel.js";
import { useOrgSignIn } from "./use-org-signin.js";
import "./org-signin.css";

function subscribe(listener: () => void): () => void {
  const offIdentity = subscribeIdentitySession(listener);
  const offSettings = subscribeSettings(listener);
  return () => {
    offIdentity();
    offSettings();
  };
}

/** Whether an Identity API is configured and a session is held, live. */
function useOffered(): boolean {
  return useSyncExternalStore(subscribe, () => orgSignInOffered());
}

type Client = ReturnType<typeof orgSignInClient>;

/** The session's organizations, read again whenever the section's list is. */
function useOrganizations(client: Client, offered: boolean, known: unknown) {
  const [orgs, setOrgs] = useState<OrgSignInOrganization[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!offered) return;
    void known;
    void round;
    let live = true;
    client.listOrganizations().then(
      (rows) => {
        if (!live) return;
        setOrgs(rows);
        setRefusal(null);
      },
      (error: unknown) => {
        if (!live) return;
        setRefusal(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [client, offered, known, round]);
  return { orgs, refusal, reload: () => setRound((n) => n + 1) };
}

function Chooser({
  orgs,
  selected,
  onSelect,
}: {
  orgs: OrgSignInOrganization[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (orgs.length < 2) return null;
  return (
    <div className="field">
      <label className="label" htmlFor="org-signin-org">
        Organization
      </label>
      <select
        id="org-signin-org"
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.displayName} ({org.slug})
          </option>
        ))}
      </select>
    </div>
  );
}

/** An owner's three panels, for one organization; keyed by it. */
function OwnerPanels({
  client,
  org,
  online,
  head,
  chooser,
}: {
  client: Client;
  org: OrgSignInOrganization;
  online: boolean;
  head: ReactNode;
  chooser: ReactNode;
}) {
  const state = useOrgSignIn(client, org);
  return (
    <>
      <UpstreamPanel
        org={org}
        state={state}
        online={online}
        redirectUri={client.redirectUri()}
        head={head}
        chooser={chooser}
      />
      <DomainsPanel state={state} online={online} />
      <TokensPanel state={state} online={online} />
      <output className="visually-hidden" aria-live="polite">
        {state.mark?.label ?? ""}
      </output>
    </>
  );
}

export function OrgSignInPanels({
  online,
  known,
}: {
  online: boolean;
  /** The section's own list of organizations: a change reads again. */
  known: unknown;
}) {
  const offered = useOffered();
  const client = useMemo(() => orgSignInClient(), []);
  const { orgs, refusal, reload } = useOrganizations(client, offered, known);
  const [chosen, setChosen] = useState("");
  if (!offered) return null;
  const reloadKey = (
    <ReloadKey
      label="Read organization sign-in again"
      disabled={!online}
      onReload={reload}
    />
  );
  if (refusal) {
    return (
      <section className="panel" aria-label="Sign-in upstream">
        <div className="panel__head">
          <h2>Sign-in upstream</h2>
          <div className="actions">
            <StatusMark tone="err" label={refusal} />
            {reloadKey}
          </div>
        </div>
      </section>
    );
  }
  if (!orgs || orgs.length === 0) return null;
  const org =
    orgs.find((entry) => entry.id === chosen) ??
    orgs.find((entry) => entry.owner) ??
    orgs[0];
  if (!org) return null;
  const chooser = (
    <Chooser orgs={orgs} selected={org.id} onSelect={setChosen} />
  );
  if (!org.owner) {
    return (
      <section className="panel" aria-label="Sign-in upstream">
        <div className="panel__head">
          <h2>Sign-in upstream</h2>
          <div className="actions">
            <StatusMark
              tone="idle"
              label={`Only an owner of ${org.displayName} can change its sign-in`}
            />
            {reloadKey}
          </div>
        </div>
        {orgs.length > 1 ? <div className="panel__body">{chooser}</div> : null}
      </section>
    );
  }
  return (
    <OwnerPanels
      key={org.id}
      client={client}
      org={org}
      online={online}
      head={reloadKey}
      chooser={chooser}
    />
  );
}
