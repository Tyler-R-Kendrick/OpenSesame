import { secretBackendPreset } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey, ReloadKey } from "../../../components/IconKey.js";
import { IconSignOut, IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../../lib/focus.js";
import { ConnectorPanel } from "../connect/ConnectorPanel.js";
import { OnePasswordSaveButton } from "./OnePasswordSaveButton.js";
import { SecretBackendBackupControls } from "./SecretBackendBackupControls.js";
import { SecretBackendFileFields } from "./SecretBackendFileFields.js";
import { SecretBackendForm } from "./SecretBackendForm.js";
import { SecretBackendHTTPRoute } from "./SecretBackendHTTPRoute.js";
import { SecretBackendWorkspace } from "./SecretBackendWorkspace.js";
import {
  type SecretBackendConnectionEditor,
  type SecretBackendPanelProps,
  useSecretBackendConnection,
} from "./useSecretBackendConnection.js";
import "../connect/connect.css";

function RemoveKey({ editor }: { editor: SecretBackendConnectionEditor }) {
  const [confirming, setConfirming] = useState(false);
  if (!editor.saved) return null;
  return (
    <>
      <IconKey
        label={
          confirming ? "Confirm remove secret backend" : "Remove secret backend"
        }
        armed={confirming}
        disabled={editor.busy}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          editor.disconnect();
          editor.remove();
          setConfirming(false);
        }}
      >
        <IconTrash size={17} />
      </IconKey>
      {confirming ? (
        <IconKey
          label="Keep secret backend"
          disabled={editor.busy}
          onClick={() => setConfirming(false)}
        >
          <IconX size={17} />
        </IconKey>
      ) : null}
    </>
  );
}
function ConfigurationPanel({
  editor,
  provider,
  online,
}: {
  editor: SecretBackendConnectionEditor;
  provider: SecretBackendPanelProps["provider"];
  online: boolean;
}) {
  const preset = secretBackendPreset(provider.id);
  if (!preset) return null;
  return (
    <ConnectorPanel
      step={2}
      label="Secret backend configuration"
      title="Configure"
      actions={
        <>
          {editor.saved ? (
            <ReloadKey
              label="Reload secret backend"
              disabled={editor.busy || !!editor.active}
              onReload={editor.reload}
            />
          ) : null}
          <RemoveKey editor={editor} />
          {editor.result ? (
            <StatusMark tone="ok" label={editor.result} />
          ) : null}
        </>
      }
    >
      <SecretBackendForm
        draft={editor.draft}
        busy={editor.busy || !!editor.active}
        saved={!!editor.saved}
        online={online}
        failure={editor.failure}
        modes={preset.modes}
        setup={preset.setup}
        docsUrl={preset.docsUrl}
        onChange={editor.changed}
        onSubmit={editor.save}
        onProbe={editor.probe}
        onReload={editor.reload}
      >
        {editor.draft.mode === "bitwarden-api" ? (
          <FieldShell
            label="Master password (this connection only)"
            value={editor.password}
            type="password"
            autoComplete="off"
            disabled={editor.busy || !!editor.active}
            onValueChange={editor.setPassword}
          />
        ) : null}
        {editor.draft.mode === "file-import" ? (
          <SecretBackendFileFields
            draft={editor.draft}
            busy={editor.busy || !!editor.active}
            onChange={editor.changed}
            formats={preset.fileFormats}
            file={editor.file}
            password={editor.password}
            onFile={editor.setFile}
            onPassword={editor.setPassword}
          />
        ) : null}
      </SecretBackendForm>
    </ConnectorPanel>
  );
}
function SessionPanel({ editor }: { editor: SecretBackendConnectionEditor }) {
  return (
    <ConnectorPanel
      id="complete"
      step={3}
      label="Secret backend session"
      title="Connect"
      actions={
        editor.active ? (
          <>
            <StatusMark tone="ok" label="Secret backend session connected" />
            <IconKey
              label="Disconnect secret backend"
              disabled={editor.busy}
              onClick={editor.disconnect}
            >
              <IconSignOut size={17} />
            </IconKey>
          </>
        ) : null
      }
    >
      {!editor.active ? (
        <div className="panel__body">
          <FormCommit
            label={
              editor.saved
                ? "Connect saved secret backend"
                : "Connect secret backend"
            }
            disabled={editor.busy}
            busy={editor.busy}
            onClick={editor.connect}
          />
          {editor.draft.mode === "encrypted-remote" ? (
            <FormCommit
              label="Initialize empty encrypted remote"
              disabled={editor.busy || !editor.saved}
              onClick={editor.initialize}
            />
          ) : null}
        </div>
      ) : null}
    </ConnectorPanel>
  );
}
export function SecretBackendPanels(props: SecretBackendPanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const wasConnected = useRef(false);
  const editor = useSecretBackendConnection(props);
  const { active, saved } = editor;
  useLayoutEffect(() => {
    if (keyboardIsIdle()) {
      const target = active
        ? root.current?.querySelector('[aria-label="Secret backend items"]')
        : wasConnected.current
          ? root.current?.querySelector('[aria-label="Secret backend session"]')
          : saved
            ? root.current?.querySelector(
                '[aria-label="Secret backend configuration"] form',
              )
            : root.current;
      landFocus(firstControl(target));
    }
    wasConnected.current = !!active;
  }, [active, saved]);
  const { setFile, setPassword, setDraft, clear } = editor;
  useEffect(
    () =>
      vaultStore.onLock(() => {
        setFile(null);
        setPassword("");
        setDraft((draft) => ({
          ...draft,
          token: "",
          clientSecret: "",
          encryptionKey: "",
        }));
        clear();
      }),
    [setFile, setPassword, setDraft, clear],
  );
  return (
    <div className="cx-setup" ref={root}>
      <ConfigurationPanel
        editor={editor}
        provider={props.provider}
        online={props.online}
      />
      <SecretBackendHTTPRoute
        draft={{
          mode: editor.draft.mode,
          baseUrl: editor.draft.baseUrl,
          identityUrl: editor.draft.identityUrl,
        }}
        online={props.online}
        busy={editor.busy || !!editor.active}
      />
      <SessionPanel editor={editor} />
      {editor.active ? (
        <SecretBackendWorkspace
          key={editor.active.session.id}
          handle={editor.active}
          onFlash={props.onFlash}
        />
      ) : null}
      {editor.active ? (
        <SecretBackendBackupControls
          key={`backup-${editor.active.session.id}`}
          handle={editor.active}
          onFlash={props.onFlash}
        />
      ) : null}
      {props.provider.id === "1password" ? (
        <OnePasswordSaveButton onFlash={props.onFlash} />
      ) : null}
      <FailureNotice
        id={`secret-backend-${props.provider.id}`}
        title={props.provider.displayName}
        message={editor.failure}
      />
    </div>
  );
}
