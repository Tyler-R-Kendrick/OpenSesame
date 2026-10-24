import {
  type OidcConnectorConfig,
  type OidcDeviceAuthorization,
  type OidcPending,
  type OidcTokens,
  beginOidcDevice,
  beginOidcLogin,
  completeOidcLogin,
  discoverOidc,
  oidcConnectorItem,
  pollOidcDevice,
} from "@opensesame/app-core/lib/custom-oidc.js";
import { useState } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconPlus } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import {
  OidcClientFields,
  OidcEndpointFields,
  OidcTokenAuthentication,
} from "./CustomOidcFields.js";

const EMPTY: OidcConnectorConfig = {
  name: "",
  issuer: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  jwksUri: "",
  deviceAuthorizationEndpoint: "",
  clientId: "",
  clientSecret: "",
  callbackUrl: "",
  tokenRelayUrl: "",
  scopes: ["openid", "profile", "email"],
  tokenAuth: "client_secret_post",
};

/** Poll at the interval the provider asks for, until it issues tokens. */
async function awaitOidcDevice(
  config: OidcConnectorConfig,
  authorization: OidcDeviceAuthorization,
): Promise<OidcTokens> {
  let interval = authorization.intervalSeconds;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const result = await pollOidcDevice(config, authorization);
    if (result.status !== "pending") return result.tokens;
    interval = result.intervalSeconds;
  }
}

/** One action at a time: busy while it runs, its failure kept till the next. */
function useOidcTask() {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fallback: string, task: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await task();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  return { failure, busy, run };
}

function useCustomOidcEditor() {
  const store = useVaultStore();
  const [config, setConfig] = useState(EMPTY);
  const [pending, setPending] = useState<OidcPending | null>(null);
  const [device, setDevice] = useState<OidcDeviceAuthorization | null>(null);
  const [callback, setCallback] = useState("");
  const [tokens, setTokens] = useState<OidcTokens | null>(null);
  const [saved, setSaved] = useState(false);
  const { failure, busy, run } = useOidcTask();

  const set = <K extends keyof OidcConnectorConfig>(
    key: K,
    value: OidcConnectorConfig[K],
  ) => setConfig((current) => ({ ...current, [key]: value }));

  async function seal(received?: OidcTokens) {
    await store.addItems([oidcConnectorItem(config, received)]);
    setSaved(true);
  }

  const discover = () =>
    run("Discovery failed", async () => {
      const found = await discoverOidc(config.issuer);
      setConfig((current) => ({ ...current, ...found }));
    });

  const start = () =>
    run("Could not start OIDC", async () => {
      const started = await beginOidcLogin(config);
      setPending(started.pending);
      setCallback("");
      window.open(started.url, "_blank", "noopener,noreferrer");
    });

  const startDevice = () =>
    run("Device authorization failed", async () => {
      const authorization = await beginOidcDevice(config);
      setDevice(authorization);
      window.open(
        authorization.verificationUriComplete ?? authorization.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
      const received = await awaitOidcDevice(config, authorization);
      setTokens(received);
      await seal(received);
      setDevice(null);
    });

  async function finish() {
    if (!pending) return;
    await run("OIDC exchange failed", async () => {
      const received = await completeOidcLogin(pending, callback);
      setTokens(received);
      await seal(received);
      setPending(null);
    });
  }

  const save = () => run("Could not save", () => seal(tokens ?? undefined));

  return {
    config,
    set,
    pending,
    device,
    callback,
    setCallback,
    failure,
    busy,
    saved,
    discover,
    start,
    startDevice,
    finish,
    save,
  };
}

type CustomOidcEditor = ReturnType<typeof useCustomOidcEditor>;

function OidcDeviceSignIn({ editor }: { editor: CustomOidcEditor }) {
  const { config, busy, device, startDevice } = editor;
  return (
    <>
      {config.deviceAuthorizationEndpoint ? (
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void startDevice()}
        >
          Use device code
        </button>
      ) : null}
      {device ? (
        <output className="note note--ok">
          Open {device.verificationUri} and enter{" "}
          <strong>{device.userCode}</strong>. Waiting for approval…
        </output>
      ) : null}
    </>
  );
}

function OidcActions({ editor }: { editor: CustomOidcEditor }) {
  const {
    busy,
    start,
    save,
    pending,
    callback,
    setCallback,
    finish,
    failure,
    saved,
  } = editor;
  return (
    <>
      <div className="button-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy}
          onClick={() => void start()}
        >
          <IconPlus size={14} /> Start sign-in
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void save()}
        >
          Save encrypted
        </button>
      </div>
      <OidcDeviceSignIn editor={editor} />
      {pending ? (
        <div className="field">
          <label htmlFor="oidc-callback-result">Paste the callback URL</label>
          <input
            id="oidc-callback-result"
            value={callback}
            onChange={(event) => setCallback(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || !callback}
            onClick={() => void finish()}
          >
            Complete exchange
          </button>
        </div>
      ) : null}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
      {saved ? <StatusMark tone="ok" label="Sealed in the vault" /> : null}
    </>
  );
}

export function CustomOidcConnector() {
  const editor = useCustomOidcEditor();
  const { config, set } = editor;
  return (
    <div className="section__inner conn-settings">
      <Link className="conn-back" to="/connections">
        <IconChevronLeft size={16} /> Connections
      </Link>
      <header className="conn-settings__head">
        <div className="conn-settings__title">
          <h1>Custom OIDC connector</h1>
          <p>
            Register an OIDC application with your provider, then keep its
            configuration sealed in this vault.
          </p>
        </div>
      </header>
      <div className="panel">
        <div className="panel__body">
          <div className="field">
            <label htmlFor="oidc-name">Connection name</label>
            <input
              id="oidc-name"
              value={config.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </div>
          <OidcEndpointFields editor={editor} />
          <OidcClientFields editor={editor} />
          <OidcTokenAuthentication editor={editor} />
          <OidcActions editor={editor} />
        </div>
      </div>
    </div>
  );
}
