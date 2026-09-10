import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { IconRefresh } from "../../components/Icons.js";
import {
  type LocalDirectory,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import { LocalAgentKeys } from "./LocalAgentKeys.js";
import { LocalPasskeys } from "./LocalPasskeys.js";

function useLocalAuthenticators(tomb: string) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const root = useRef<HTMLElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const focusSource = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = focusSource.current;
    focusSource.current = null;
    if (
      previous &&
      !previous.isConnected &&
      document.activeElement === document.body
    )
      reloadButton.current?.focus();
  });
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await readLocalDirectory(tomb);
      if (generation.current !== current) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && root.current?.contains(focused))
        focusSource.current = focused;
      setDirectory(next);
      setError("");
    } catch {
      if (generation.current !== current) return;
      setError(
        "Could not read authenticators. Unlock this vault and reload the directory.",
      );
    }
  }, [tomb]);
  useEffect(() => {
    const refresh = () => void reload();
    const off = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      generation.current++;
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  return { directory, error, root, reloadButton, reload };
}

export function LocalDevicesPanel({ tomb }: { tomb: string }) {
  const { directory, error, root, reloadButton, reload } =
    useLocalAuthenticators(tomb);
  const identities = directory?.entries.filter(
    (entry) => entry.kind === "person" || entry.kind === "agent",
  );
  return (
    <section className="panel" aria-label="Local authenticators" ref={root}>
      <div className="panel__head">
        <h2>Authenticators</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Reload directory"
          title="Reload directory"
          ref={reloadButton}
          onClick={() => void reload()}
        >
          <IconRefresh />
        </button>
      </div>
      <div className="panel__body">
        <p className="hint identity-authenticator-intro">
          Enroll and revoke this vault's sign-in keys. Synced passkeys can be
          available on several devices; this is not a physical-device inventory.
        </p>
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {!directory && !error ? <output>Loading authenticators…</output> : null}
        {identities?.length === 0 && !error ? (
          <p className="hint">
            No local identities yet.{" "}
            <Link to="/identity?view=people">Create a person</Link> to enroll a
            passkey.
          </p>
        ) : null}
        <ul className="identity-rows">
          {identities?.map((entry) => (
            <li className="identity-row" key={entry.id}>
              <div className="identity-row__main">
                <div className="identity-row__id">
                  <h3>{entry.name}</h3>
                  <code className="identity-ref">{entry.id}</code>
                </div>
                <span className="chip">
                  {entry.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {entry.kind === "person" ? (
                <LocalPasskeys
                  tomb={tomb}
                  principalId={entry.id}
                  disabled={Boolean(error)}
                  enabled={entry.enabled}
                />
              ) : (
                <LocalAgentKeys
                  tomb={tomb}
                  principalId={entry.id}
                  disabled={Boolean(error)}
                  enabled={entry.enabled}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
