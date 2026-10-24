import { useLayoutEffect, useRef } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { IconKey, ReloadKey } from "../../../components/IconKey.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { IdentityConnectionSignIn } from "../../../components/IdentityConnectionSignIn.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../../lib/focus.js";
import { ConnectorPanel } from "../connect/ConnectorPanel.js";
import { IdentityConnectionForm } from "./IdentityConnectionForm.js";
import { identityConnectionDependencies as dependencies } from "./identity-connection-dependencies.js";
import {
  type IdentityConnectionEditor,
  type IdentityConnectionPanelProps,
  useIdentityConnection,
} from "./useIdentityConnection.js";
import "../connect/connect.css";
export {
  identityConnectionDependencies,
  isIdentityConnectionProvider,
} from "./identity-connection-dependencies.js";

function ConfigurationPanel({
  editor,
  online,
}: { editor: IdentityConnectionEditor; online: boolean }) {
  return (
    <ConnectorPanel
      step={2}
      label="Identity configuration"
      title="Configure"
      actions={
        <>
          {editor.saved ? (
            <ReloadKey
              label="Reload identity connection"
              disabled={editor.busy}
              onReload={editor.reload}
            />
          ) : null}
          {editor.result ? (
            <StatusMark tone="ok" label={editor.result} />
          ) : null}
        </>
      }
    >
      <IdentityConnectionForm
        draft={editor.draft}
        busy={editor.busy}
        online={online}
        failure={editor.failure}
        saved={!!editor.saved}
        organizations={editor.organizations}
        onChange={editor.changed}
        onSubmit={editor.save}
        onTest={editor.test}
        onReload={editor.reload}
        onLoadOrganizations={editor.loadOrganizations}
        onConnectService={editor.connectService}
        onSignInService={editor.signInService}
      />
    </ConnectorPanel>
  );
}
function SignInPanel({
  editor,
  online,
}: { editor: IdentityConnectionEditor; online: boolean }) {
  const removeRef = useRef<HTMLButtonElement>(null);
  const { saved, confirming, busy } = editor;
  if (!saved) return null;
  return (
    <ConnectorPanel
      id="complete"
      step={3}
      label="Identity sign-in"
      title="Sign in"
      actions={
        <>
          <IconKey
            label={
              confirming
                ? "Confirm remove identity connection"
                : "Remove identity connection"
            }
            keyRef={removeRef}
            armed={confirming}
            disabled={busy}
            onClick={() => void editor.remove()}
          >
            <IconTrash size={17} />
          </IconKey>
          {confirming ? (
            <IconKey
              label="Keep identity connection"
              disabled={busy}
              onClick={() => {
                editor.setConfirming(false);
                landFocus(removeRef.current);
              }}
            >
              <IconX size={17} />
            </IconKey>
          ) : null}
        </>
      }
    >
      <IdentityConnectionSignIn
        className="cx-form panel__body"
        key={`${saved.connectionId}/${saved.updatedAt}`}
        draft={
          dependencies.readIdentityConnection(saved.connectionId) ??
          editor.draft
        }
        busy={busy}
        online={online}
        failure={editor.failure}
        onSignIn={editor.signIn}
      />
    </ConnectorPanel>
  );
}
export function IdentityConnectionPanels(props: IdentityConnectionPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editor = useIdentityConnection(props);
  const { saved } = editor;
  useLayoutEffect(() => {
    if (keyboardIsIdle())
      landFocus(
        saved
          ? firstControl(rootRef.current)
          : rootRef.current?.querySelector("input"),
      );
  }, [saved]);
  return (
    <div className="cx-setup" ref={rootRef}>
      <ConfigurationPanel editor={editor} online={props.online} />
      <SignInPanel editor={editor} online={props.online} />
      <FailureNotice
        id={`identity-connection-${props.provider.id}`}
        title="Identity connection"
        message={editor.failure}
      />
    </div>
  );
}
