import { useCallback, useEffect, useRef, useState } from "react";
import {
  type LocalAccessRequest,
  listLocalAccessRequests,
} from "../../lib/local-access-requests.js";
import { readLocalApplications } from "../../lib/local-applications.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";

async function read(tomb: string) {
  const [directory, applications, requests] = await Promise.all([
    readLocalDirectory(tomb),
    readLocalApplications(tomb),
    listLocalAccessRequests(tomb),
  ]);
  return { directory, applications: applications.applications, requests };
}

export function useLocalRequests(tomb: string) {
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const alive = useRef(false);
  const writing = useRef(false);
  const reload = useCallback(async () => {
    const turn = ++generation.current;
    try {
      const next = await read(tomb);
      if (!alive.current || turn !== generation.current) return;
      setData(next);
      setError("");
    } catch {
      if (!alive.current || turn !== generation.current) return;
      setError(
        "Could not read local requests. Unlock the vault and reload; existing drafts have been kept.",
      );
    }
  }, [tomb]);
  useEffect(() => {
    alive.current = true;
    const refresh = () => void reload();
    const off = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      alive.current = false;
      generation.current++;
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  useEffect(() => {
    const active = data?.requests.filter(
      (row) => row.status === "pending" || row.status === "approved",
    );
    if (!active?.length) return;
    const deadline = Math.min(...active.map((row) => row.expiresAt));
    const timer = setTimeout(
      () => void reload(),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [data, reload]);
  async function run(
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    success: string,
  ) {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (!alive.current) return false;
      await reload();
      if (!alive.current) return false;
      setMessage(success);
      return true;
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof LocalDirectoryError
            ? failure.message
            : "The request operation failed. Reload and retry; your draft has been kept.",
        );
      return false;
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { data, error, busy, message, reload, run };
}
