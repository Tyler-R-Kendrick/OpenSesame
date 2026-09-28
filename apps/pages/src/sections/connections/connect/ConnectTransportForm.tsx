/**
 * The Vercel Connect credential, asked for once (ADR 0127 / ADR 0147).
 *
 * With this deployment's relay: its management key. Without one: a Vercel
 * access token and team, used straight from this page. Either is sealed in
 * the vault, never stored in the clear. Shared by a connector's own page and
 * the Connections page's import, so sealing it means the same thing in both.
 */
import { armVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect-session.js";
import { vercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconLock } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { OutLink } from "./fields.js";

/** No relay here: a Vercel token and team, used straight from this page. */
function DirectFields({
  token,
  teamId,
  projectId,
  onToken,
  onTeamId,
  onProjectId,
}: {
  token: string;
  teamId: string;
  projectId: string;
  onToken: (value: string) => void;
  onTeamId: (value: string) => void;
  onProjectId: (value: string) => void;
}) {
  return (
    <>
      <FieldShell
        label="Vercel access token"
        type="password"
        value={token}
        autoComplete="off"
        mono
        onValueChange={onToken}
      />
      <div className="cx-grid">
        <FieldShell
          label="Team ID"
          value={teamId}
          mono
          onValueChange={onTeamId}
        />
        <FieldShell
          label="Project ID"
          value={projectId}
          mono
          onValueChange={onProjectId}
        />
      </div>
      <div className="cx-links">
        <OutLink href="https://vercel.com/account/settings/tokens">
          Vercel tokens
        </OutLink>
      </div>
    </>
  );
}

export function ConnectTransportForm({
  relay,
  onFlash,
  onSealed,
}: {
  relay: boolean;
  onFlash: (flash: Flash) => void;
  /** After the credential is sealed: the caller reads what it opens. */
  onSealed?: () => void;
}) {
  const { tomb } = useVault();
  const current = vercelConnectAuth();
  const [manageKey, setManageKey] = useState("");
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState(current?.teamId ?? "");
  const [projectId, setProjectId] = useState(current?.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const ready = relay ? manageKey.trim().length >= 32 : token.trim().length > 0;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await armVercelConnectAuth(
        relay
          ? { ...(current ?? { token: "" }), manageKey: manageKey.trim() }
          : {
              token: token.trim(),
              teamId,
              projectId,
              manageKey: current?.manageKey,
            },
        tomb,
      );
      setManageKey("");
      setToken("");
      onFlash({ tone: "ok", text: "Vercel Connect is ready on this device." });
      onSealed?.();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cx-form panel__body" onSubmit={save}>
      {relay ? (
        <FieldShell
          label="Relay management key"
          type="password"
          value={manageKey}
          autoComplete="off"
          mono
          onValueChange={setManageKey}
        />
      ) : (
        <DirectFields
          token={token}
          teamId={teamId}
          projectId={projectId}
          onToken={setToken}
          onTeamId={setTeamId}
          onProjectId={setProjectId}
        />
      )}
      <FormCommit
        label={busy ? "Sealing" : "Seal in vault"}
        icon={<IconLock size={18} />}
        busy={busy}
        disabled={busy || !ready}
      />
    </form>
  );
}
