import {
  type LocalAgentKey,
  readLocalAgentKeys,
  registerLocalAgentKey,
  revokeLocalAgentKey,
} from "@opensesame/app-core/lib/local-agent-keys.js";
import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { revokeLocalIdentitySession } from "@opensesame/app-core/lib/local-sessions.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  IconLock,
  IconPasskey,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { LocalAgentAuthentication } from "./LocalAgentAuthentication.js";
import { LocalAgentEnrollment } from "./LocalAgentEnrollment.js";
import { useLocalSessionPresentation } from "./LocalIdentitySession.js";

type Props = {
  tomb: string;
  principalId: string;
  disabled: boolean;
  enabled: boolean;
};

export function LocalAgentKeys(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Agent keys</summary>
      {open ? <AgentKeyCommands {...props} /> : null}
    </details>
  );
}

function useAgentKeys(tomb: string, principalId: string) {
  const [keys, setKeys] = useState<LocalAgentKey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await readLocalAgentKeys(tomb);
      if (current === generation.current) {
        setKeys(next.filter((key) => key.principalId === principalId));
        setError("");
      }
    } catch {
      if (current === generation.current) {
        setKeys(null);
        setError(
          "Could not read agent keys. Unlock the vault and reload keys.",
        );
      }
    }
  }, [tomb, principalId]);
  useEffect(() => {
    const listener = () => {
      void refresh();
    };
    const off = subscribeLocalIamChanges(listener);
    window.addEventListener("focus", listener);
    listener();
    return () => {
      generation.current++;
      off();
      window.removeEventListener("focus", listener);
    };
  }, [refresh]);
  async function run(action: () => Promise<void>, success: string) {
    if (busy || !keys) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await refresh();
      setMessage(success);
      return true;
    } catch (failure) {
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "Could not save this change. Unlock the vault and retry; your draft has been kept.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { keys, busy, error, message, refresh, run };
}

function useAgentKeySelection(busy: boolean) {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<LocalAgentKey | null>(null);
  const source = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (adding || selected || busy) return;
    if (document.activeElement !== document.body || !source.current) return;
    if (source.current.isConnected) source.current.focus();
    else root.current?.closest("details")?.querySelector("summary")?.focus();
    source.current = null;
  }, [adding, selected, busy]);
  return { adding, setAdding, selected, setSelected, source, root };
}

function AgentKeyCommands(props: Props) {
  const model = useAgentKeys(props.tomb, props.principalId);
  const session = useLocalSessionPresentation(props.tomb, props.principalId);
  const { adding, setAdding, selected, setSelected, source, root } =
    useAgentKeySelection(model.busy);
  const disabled = props.disabled || model.busy;
  return (
    <div ref={root} aria-busy={model.busy}>
      <AgentKeyStatus model={model} session={session} />
      <AgentCommands
        disabled={disabled}
        enrollDisabled={
          !props.enabled || !model.keys || adding || selected !== null
        }
        enroll={(target) => {
          source.current = target;
          setAdding(true);
        }}
        reload={() => void model.refresh()}
        signOut={
          session.session
            ? () => {
                const active = session.session;
                if (active)
                  void model.run(
                    () => revokeLocalIdentitySession(props.tomb, active.id),
                    "Agent session revoked.",
                  );
              }
            : null
        }
      />
      {adding ? (
        <LocalAgentEnrollment
          disabled={disabled}
          save={(input) =>
            model.run(
              () => registerLocalAgentKey(props.tomb, props.principalId, input),
              "Agent key enrolled.",
            )
          }
          close={() => setAdding(false)}
        />
      ) : null}
      <AgentKeyRows
        keys={model.keys ?? []}
        disabled={disabled || adding || selected !== null}
        enabled={props.enabled}
        authenticate={(key, target) => {
          source.current = target;
          setSelected(key);
        }}
        revoke={(key, target) => {
          source.current = target;
          return model.run(
            () =>
              revokeLocalAgentKey(
                props.tomb,
                props.principalId,
                key.credentialId,
              ),
            "Agent key revoked.",
          );
        }}
      />
      {selected ? (
        <LocalAgentAuthentication
          tomb={props.tomb}
          agentKey={selected}
          disabled={disabled || !props.enabled}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function AgentKeyStatus({
  model,
  session,
}: {
  model: ReturnType<typeof useAgentKeys>;
  session: ReturnType<typeof useLocalSessionPresentation>;
}) {
  const keyTone = model.error
    ? "err"
    : model.keys && model.keys.length > 0
      ? "ok"
      : "idle";
  const keyLabel =
    model.error ||
    model.message ||
    (model.keys?.length === 0
      ? "No agent keys enrolled."
      : !model.keys
        ? "Loading agent keys…"
        : "Agent keys");
  const sessionTone = session.error ? "err" : session.session ? "ok" : "idle";
  const sessionLabel =
    session.error || session.message || "No active local session.";
  return (
    <div className="actions">
      <StatusMark tone={keyTone} label={keyLabel} />
      <StatusMark tone={sessionTone} label={sessionLabel} />
      {model.error ? (
        <span role="alert" className="visually-hidden">
          {model.error}
        </span>
      ) : (
        <output className="visually-hidden" aria-label="Agent key status">
          {model.message}
        </output>
      )}
      {session.error ? (
        <span role="alert" className="visually-hidden">
          {session.error}
        </span>
      ) : (
        <output className="visually-hidden" aria-label="Agent session status">
          {session.message}
        </output>
      )}
    </div>
  );
}

function AgentCommands({
  disabled,
  enrollDisabled,
  enroll,
  reload,
  signOut,
}: {
  disabled: boolean;
  enrollDisabled: boolean;
  enroll: (target: HTMLElement) => void;
  reload: () => void;
  signOut: (() => void) | null;
}) {
  return (
    <div className="actions">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={disabled || enrollDisabled}
        onClick={(event) => enroll(event.currentTarget)}
        aria-label="Enroll public key"
        title="Enroll public key"
      >
        <IconPlus size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={disabled}
        onClick={reload}
        aria-label="Reload keys"
        title="Reload keys"
      >
        <IconRefresh size={16} />
      </button>
      {signOut ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={disabled}
          onClick={() => signOut()}
          aria-label="Sign out agent"
          title="Sign out agent"
        >
          <IconLock size={16} />
        </button>
      ) : null}
    </div>
  );
}

function AgentKeyRows({
  keys,
  disabled,
  enabled,
  authenticate,
  revoke,
}: {
  keys: LocalAgentKey[];
  disabled: boolean;
  enabled: boolean;
  authenticate: (key: LocalAgentKey, target: HTMLElement) => void;
  revoke: (key: LocalAgentKey, target: HTMLElement) => Promise<boolean>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <ul className="identity-passkeys">
      {keys.map((key) => (
        <li key={key.credentialId}>
          <div className="identity-row__main">
            <span>ES256 · {key.keyId.slice(-12)}</span>
            <span className="hint">
              Enrolled {new Date(key.createdAt).toLocaleDateString()}
            </span>
            <div className="actions">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                disabled={disabled || !enabled}
                onClick={(event) => authenticate(key, event.currentTarget)}
                aria-label="Authenticate agent"
                title="Authenticate agent"
              >
                <IconPasskey size={16} />
              </button>
              <button
                type="button"
                className={
                  removing === key.credentialId
                    ? "icon-btn icon-btn--sm icon-btn--danger is-armed"
                    : "icon-btn icon-btn--sm icon-btn--danger"
                }
                disabled={disabled}
                onClick={(event) => {
                  if (removing === key.credentialId)
                    void revoke(key, event.currentTarget).then((saved) => {
                      if (saved) setRemoving(null);
                    });
                  else setRemoving(key.credentialId);
                }}
                aria-label={
                  removing === key.credentialId
                    ? "Confirm key revocation"
                    : "Revoke agent key"
                }
                title={
                  removing === key.credentialId
                    ? "Confirm key revocation"
                    : "Revoke agent key"
                }
              >
                <IconTrash size={16} />
              </button>
              {removing === key.credentialId ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={disabled}
                  onClick={(event) => {
                    const primary = event.currentTarget.previousElementSibling;
                    setRemoving(null);
                    if (primary instanceof HTMLButtonElement) primary.focus();
                  }}
                  aria-label="Keep agent key"
                  title="Keep agent key"
                >
                  <IconX size={16} />
                </button>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
