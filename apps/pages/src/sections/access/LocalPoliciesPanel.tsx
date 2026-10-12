import {
  type LocalDirectory,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { LocalApplicationSettings } from "../identity/LocalApplicationSettings.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

export function LocalPoliciesPanel() {
  const { tomb } = useVault();
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
  const selection = useAccessRecord("local-policies", "policies");
  const selected = applications?.find(
    (application) => application.id === selection.id,
  );
  return (
    <AccessRecords
      title="Local application policies"
      emptyMessage={
        error
          ? "Unavailable"
          : !directory
            ? "Loading…"
            : "No local applications."
      }
      selection={selection}
      rows={(applications ?? []).map((application) => ({
        id: application.id,
        label: application.name,
        extension: "policy",
        to: selection.path(application.id),
      }))}
      commands={
        <>
          {error ? <StatusMark tone="err" label={error} /> : null}
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title="Reload local policies"
            aria-label="Reload local policies"
            onClick={() => void reload()}
          >
            <IconRefresh size={15} />
          </button>
        </>
      }
      status={
        <FailureNotice id="access:policies" title="Policies" message={error} />
      }
    >
      {!directory && !error ? <output>Loading local policies…</output> : null}
      {selected && directory ? (
        <AccessDetail title={selected.name} kind="Application policy">
          <AccessFact label="Reference" value={selected.id} />
          <LocalApplicationSettings
            tomb={tomb}
            applicationId={selected.id}
            directory={directory}
            disabled={Boolean(error) || !selected.enabled}
          />
        </AccessDetail>
      ) : null}
    </AccessRecords>
  );
}
