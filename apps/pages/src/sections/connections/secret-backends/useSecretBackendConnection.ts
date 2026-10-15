import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type {
  SecretBackendConfiguration,
  SecretBackendDraft,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import {
  currentSecretBackend,
  secretBackendDependencies as dependencies,
} from "./secret-backend-dependencies.js";
import { useSecretBackendAction } from "./useSecretBackendAction.js";
import { useSecretBackendSession } from "./useSecretBackendSession.js";

export type SecretBackendPanelProps = {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
};
function useBackendDraft(props: SecretBackendPanelProps) {
  const [saved, setSaved] = useState(() =>
    currentSecretBackend(props.provider.id, props.connection),
  );
  const [draft, setDraft] = useState(
    () =>
      (saved && dependencies.readSecretBackendConnection(saved.connectionId)) ||
      dependencies.secretBackendDraft(props.provider.id),
  );
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  return {
    saved,
    setSaved,
    draft,
    setDraft,
    file,
    setFile,
    password,
    setPassword,
  };
}
function configurationActions(
  editor: ReturnType<typeof useBackendDraft>,
  status: ReturnType<typeof useSecretBackendAction>,
  props: SecretBackendPanelProps,
) {
  function changed(key: keyof SecretBackendDraft, value: string) {
    editor.setDraft((draft) => {
      const next = { ...draft, [key]: value };
      if (key === "mode") {
        next.token = "";
        next.clientSecret = "";
      }
      return next;
    });
    if (key === "mode" || key === "fileFormat") {
      editor.setFile(null);
      editor.setPassword("");
    }
    status.clear();
  }
  function reload() {
    if (!editor.saved) return;
    const draft = dependencies.readSecretBackendConnection(
      editor.saved.connectionId,
    );
    if (draft) {
      editor.setDraft(draft);
      status.clear();
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void status.run(async () => {
      const saved = await dependencies.saveSecretBackendConnection(
        editor.draft,
        editor.saved?.connectionId,
      );
      editor.setSaved(saved);
      const draft = dependencies.readSecretBackendConnection(
        saved.connectionId,
      );
      if (draft) editor.setDraft(draft);
      props.onChanged();
      return "Secret backend configuration saved";
    });
  }
  function remove() {
    void status.run(async () => {
      if (!editor.saved) return undefined;
      await dependencies.deleteSecretBackendConnection(
        editor.saved.connectionId,
      );
      editor.setSaved(null);
      editor.setDraft(dependencies.secretBackendDraft(props.provider.id));
      props.onChanged();
      return "Secret backend configuration removed";
    });
  }
  return { changed, reload, save, remove };
}
export function useSecretBackendConnection(props: SecretBackendPanelProps) {
  const editor = useBackendDraft(props);
  const status = useSecretBackendAction(props.onFlash);
  const session = useSecretBackendSession(status.clear);
  const config = (): SecretBackendConfiguration => ({
    ...editor.draft,
    file: editor.file ?? undefined,
    filePassword: editor.password,
  });
  function probe() {
    void status.run(async (action) => {
      try {
        await dependencies.probeSecretBackend(
          config(),
          editor.saved?.connectionId,
          action.signal,
        );
        action.check();
        return "Secret backend connection verified";
      } finally {
        if (action.current()) editor.setPassword("");
      }
    });
  }
  function connect() {
    void status.run(async (action) => {
      const attempt = session.begin(action.signal);
      const current = () => action.current() && attempt.current();
      if (!attempt.current()) return undefined;
      try {
        const savedId = editor.saved?.connectionId;
        const saved = savedId
          ? dependencies.readSecretBackendConnection(savedId)
          : null;
        const input =
          savedId && saved && saved.mode !== "file-import"
            ? savedId
            : {
                ...(saved ?? editor.draft),
                file: editor.file ?? undefined,
                filePassword: editor.password,
              };
        const accepted = session.accept(
          attempt,
          await dependencies.connectSecretBackend(
            input,
            editor.saved?.connectionId,
            attempt.signal,
          ),
        );
        return accepted && current()
          ? "Secret backend session connected"
          : undefined;
      } catch (error) {
        if (attempt.current()) throw error;
        return undefined;
      } finally {
        if (current()) editor.setPassword("");
        session.end(attempt);
      }
    });
  }
  function disconnect() {
    session.disconnect();
    status.clear();
    editor.setFile(null);
    editor.setPassword("");
  }
  return {
    ...editor,
    ...status,
    ...session,
    ...configurationActions(editor, status, props),
    probe,
    connect,
    disconnect,
  };
}
export type SecretBackendConnectionEditor = ReturnType<
  typeof useSecretBackendConnection
>;
