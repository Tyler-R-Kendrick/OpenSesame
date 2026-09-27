import {
  armVercelConnectAuth,
  forgetVercelConnectAuth,
} from "@opensesame/app-core/lib/vercel-connect-session.js";
import { vercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconLock, IconTrash } from "../../../components/Icons.js";
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

/** The one key that forgets the held Connect credential, memory and vault. */
function ForgetConnectKey({
  tomb,
  onFlash,
  onForgotten,
}: {
  tomb: string | undefined;
  onFlash: (flash: Flash) => void;
  onForgotten: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function forget() {
    setBusy(true);
    try {
      await forgetVercelConnectAuth(tomb || null);
      onForgotten();
      onFlash({
        tone: "ok",
        text: "Vercel Connect is forgotten on this device.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm icon-btn--danger"
      aria-label="Forget Vercel Connect"
      title="Forget Vercel Connect"
      disabled={busy}
      onClick={() => void forget()}
    >
      <IconTrash size={15} />
    </button>
  );
}

/**
 * Where connectors live. With this deployment's relay: its management key.
 * Without one: a Vercel access token and team, used straight from this
 * page. Either is sealed in the vault (ADR 0127), never stored in the clear.
 * Once one is held, the head carries the one key that forgets it: out of
 * memory and out of the vault. With the form satisfied the panel is only
 * that key.
 */
export function ConnectTransportPanel({
  relay,
  showForm,
  held,
  onFlash,
}: {
  relay: boolean;
  /** False once this session can already manage connectors. */
  showForm: boolean;
  /** This session holds a Connect credential to forget. */
  held: boolean;
  onFlash: (flash: Flash) => void;
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
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel"
      id="connect-transport"
      aria-label="Vercel Connect"
    >
      <div className="panel__head">
        <h2>Vercel Connect</h2>
        {held ? (
          <ForgetConnectKey
            tomb={tomb}
            onFlash={onFlash}
            onForgotten={() => {
              setTeamId("");
              setProjectId("");
            }}
          />
        ) : null}
      </div>
      {showForm ? (
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
      ) : null}
    </section>
  );
}
