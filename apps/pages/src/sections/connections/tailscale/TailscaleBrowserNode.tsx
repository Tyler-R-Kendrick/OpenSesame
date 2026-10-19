import { useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { TailscaleNativeHTTPFields } from "./TailscaleNativeHTTPFields.js";
import {
  type BrowserNodeEditor,
  useTailscaleBrowserNode,
} from "./useTailscaleBrowserNode.js";
function NodeFields({ model }: { model: BrowserNodeEditor }) {
  const disabled = !model.ready || model.active || model.busy;
  return (
    <>
      <FieldShell
        label="Browser node hostname"
        value={model.hostname}
        disabled={disabled}
        onValueChange={model.setHostname}
      />
      <FieldShell
        label="Tailscale control server"
        value={model.controlURL}
        type="url"
        disabled={disabled}
        onValueChange={model.setControlURL}
      />
      <details className="conn-client-alt">
        <summary>Join with an existing auth key</summary>
        <FieldShell
          label="Optional node auth key"
          value={model.authKey}
          type="password"
          autoComplete="off"
          disabled={disabled}
          onValueChange={model.setAuthKey}
        />
      </details>
      <TailscaleNativeHTTPFields
        values={model.nativeHTTPValues}
        onChange={model.setNativeHTTPValue}
        disabled={disabled}
      />
      <p>
        The official Tailscale client runs inside this PWA. Sign in to join this
        browser node, or supply a provider-issued auth key. Private node state
        is encrypted in this vault.
      </p>
    </>
  );
}
function NodeStatus({ model }: { model: BrowserNodeEditor }) {
  const { state, node } = model;
  return (
    <>
      <FailureNotice
        id="tailscale-browser-node"
        title="Tailscale"
        message={model.failure || state.failure || model.probeFailure}
      />
      {state.status === "login" && !state.authURL ? (
        <FormCommit
          label="Sign in to Tailscale"
          onClick={() => node?.login()}
        />
      ) : null}
      {state.authURL ? (
        <a href={state.authURL} target="_blank" rel="noreferrer noopener">
          Continue signing in with Tailscale
        </a>
      ) : null}
      {state.status === "approval" ? (
        <StatusMark
          tone="err"
          label="Approve this browser node in your Tailscale admin console."
        />
      ) : null}
      {state.status === "connected" ? (
        <StatusMark
          tone="ok"
          label={`Connected: ${state.addresses.join(", ")} · ${state.peerCount} peers`}
        />
      ) : null}
      {model.failure || state.failure ? (
        <StatusMark tone="err" label={model.failure || state.failure} />
      ) : null}
    </>
  );
}
function PeerProbe({ model }: { model: BrowserNodeEditor }) {
  if (model.state.status !== "connected") return null;
  return (
    <>
      <FieldShell
        label="Tailnet service URL"
        value={model.peerURL}
        type="url"
        onValueChange={model.setPeerURL}
      />
      <FormCommit
        label="Test tailnet service"
        disabled={!model.peerURL}
        onClick={model.testPeer}
      />
      {model.probeFailure ? (
        <StatusMark tone="err" label={model.probeFailure} />
      ) : null}
      {model.probe ? <StatusMark tone="ok" label={model.probe} /> : null}
    </>
  );
}
function ForgetNode({ model }: { model: BrowserNodeEditor }) {
  const [armed, setArmed] = useState(false);
  if (!model.hasSaved) return null;
  return (
    <IconKey
      label={
        armed
          ? "Confirm forget local browser node"
          : "Forget local browser node"
      }
      armed={armed}
      disabled={model.busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        model.forget();
        setArmed(false);
      }}
    >
      <IconTrash size={17} />
    </IconKey>
  );
}
export function TailscaleBrowserNode({
  ready,
  online,
}: { ready: boolean; online: boolean }) {
  const model = useTailscaleBrowserNode(ready);
  return (
    <section className="panel" aria-label="Tailscale browser node">
      <div className="panel__head">
        <h2>
          <span className="cx-step">1</span> Connect this PWA to Tailscale
        </h2>
      </div>
      <form
        className="cx-form panel__body"
        onSubmit={(event) => {
          event.preventDefault();
          model.start();
        }}
      >
        <NodeFields model={model} />
        {!model.node ? (
          <StatusMark
            tone="err"
            label="Enable Networking in Features to connect this browser node."
          />
        ) : null}
        <FormCommit
          label="Save browser node configuration"
          disabled={!ready || model.busy}
          onClick={model.save}
        />
        <FormCommit
          label="Connect browser node"
          disabled={
            !model.node || !ready || !online || model.active || model.busy
          }
        >
          <ForgetNode model={model} />
          {model.active ? (
            <IconKey
              label="Disconnect browser node"
              disabled={model.busy}
              onClick={() => model.node?.stop()}
            >
              <IconX size={17} />
            </IconKey>
          ) : null}
        </FormCommit>
        <NodeStatus model={model} />
        <PeerProbe model={model} />
      </form>
    </section>
  );
}
