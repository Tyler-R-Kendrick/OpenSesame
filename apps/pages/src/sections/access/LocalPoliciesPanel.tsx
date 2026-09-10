import { useCallback, useEffect, useRef, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import {
  type LocalDirectory,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { LocalApplicationSettings } from "../identity/LocalApplicationSettings.js";

export function LocalPoliciesPanel() {
  const tomb = useVaultStore().activeTomb();
  return <LocalPolicyEditor key={tomb} tomb={tomb} />;
}

function usePolicyDirectory(tomb: string) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await readLocalDirectory(tomb);
      if (request !== generation.current) return;
      setDirectory(next);
      setError("");
    } catch {
      if (request === generation.current)
        setError(
          "Could not read local policy subjects. Unlock this vault and reload.",
        );
    }
  }, [tomb]);
  useEffect(() => {
    const refresh = () => void reload();
    const unsubscribe = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      generation.current++;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  return { directory, error, reload };
}

export function LocalPolicyEditor({ tomb }: { tomb: string }) {
  const { directory, error, reload } = usePolicyDirectory(tomb);
  const applications = directory?.entries.filter(
    (entry) => entry.kind === "application",
  );
  return (
    <section className="panel" aria-label="Local application policies">
      <div className="panel__head">
        <h2>Local application policies</h2>
        <button
          type="button"
          className="icon-btn"
          title="Reload local policies"
          aria-label="Reload local policies"
          onClick={() => void reload()}
        >
          <IconRefresh />
        </button>
      </div>
      <div className="panel__body">
        <p className="hint local-policy-intro">
          Choose which organization roles may request each application scope.
          Unchecked roles are denied, including owners. Saving a changed policy
          invalidates existing application grants; a new sign-in and explicit
          consent are required.
        </p>
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {!directory && !error ? <output>Loading local policies…</output> : null}
        {directory && applications ? (
          <>
            <p className="hint">Applications: {applications.length || "-"}</p>
            {applications.length ? (
              applications.map((application) => (
                <div key={application.id}>
                  <h3>{application.name}</h3>
                  <p>
                    <code className="access-ref">{application.id}</code>
                  </p>
                  {!application.enabled ? (
                    <p className="hint">
                      Disabled application. Enable it in Identity before
                      changing its policy.
                    </p>
                  ) : null}
                  <LocalApplicationSettings
                    tomb={tomb}
                    applicationId={application.id}
                    directory={directory}
                    disabled={Boolean(error) || !application.enabled}
                  />
                </div>
              ))
            ) : (
              <p>
                No local applications. Create an application and its
                organization in Identity → Applications, then configure its
                scope policy here.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
