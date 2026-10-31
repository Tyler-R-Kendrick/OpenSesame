import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type {
  IdentityConnectionCredentials,
  IdentityConnectionDraft,
} from "@opensesame/app-core/lib/identity-connections-schema.js";
import type { OrgSignInOrganization } from "@opensesame/app-core/lib/org-signin.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import {
  currentIdentityConnection,
  identityConnectionDependencies as dependencies,
} from "./identity-connection-dependencies.js";

export type IdentityConnectionPanelProps = {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  initialOidcTransport?: IdentityConnectionDraft["oidcTransport"];
};

function useIdentityDraft(
  provider: Provider,
  connection: Connection | null,
  initialOidcTransport?: IdentityConnectionDraft["oidcTransport"],
) {
  const [saved, setSaved] = useState(() =>
    currentIdentityConnection(provider.id, connection),
  );
  const [draft, setDraft] = useState(() => {
    const initial = dependencies.readInitialIdentityDraft(
      provider.id,
      saved?.connectionId,
    );
    return {
      ...initial,
      oidcTransport: saved
        ? initial.oidcTransport
        : (initialOidcTransport ?? initial.oidcTransport),
      brokerUrl: initial.brokerUrl || dependencies.readSignInService(),
    };
  });
  const [organizations, setOrganizations] = useState<OrgSignInOrganization[]>(
    [],
  );
  return { saved, setSaved, draft, setDraft, organizations, setOrganizations };
}
function useIdentityStatus(onFlash: IdentityConnectionPanelProps["onFlash"]) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState("");
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure("");
    setResult("");
    try {
      await action();
    } catch (error) {
      const message = errorText(error);
      setFailure(message);
      onFlash({ tone: "err", text: message });
    } finally {
      setBusy(false);
    }
  }
  return { busy, failure, setFailure, result, setResult, run };
}
type DraftState = ReturnType<typeof useIdentityDraft>;
type StatusState = ReturnType<typeof useIdentityStatus>;

function configurationActions(
  editor: DraftState,
  status: StatusState,
  props: IdentityConnectionPanelProps,
) {
  const { draft, saved, setDraft, setSaved } = editor;
  const { run, setFailure, setResult } = status;
  function changed(key: keyof IdentityConnectionDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFailure("");
    setResult("");
  }
  function reload() {
    if (!saved) return;
    const loaded = dependencies.readIdentityConnection(saved.connectionId);
    if (!loaded) {
      setFailure(
        "Identity configuration is no longer available. Reload connections.",
      );
      return;
    }
    setDraft(loaded);
    setFailure("");
    setResult("Identity configuration reloaded");
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const next = await dependencies.saveIdentityConnection(
        draft,
        saved?.connectionId,
      );
      setSaved(next);
      const loaded = dependencies.readIdentityConnection(next.connectionId);
      if (loaded) setDraft(loaded);
      setResult("Identity configuration saved");
      props.onFlash({
        tone: "ok",
        text: `${next.displayName} identity configuration saved.`,
      });
      props.onChanged();
    });
  }
  function test() {
    void run(async () => {
      const tested = await dependencies.testIdentityConnection(
        draft,
        saved?.connectionId,
      );
      setResult(tested.message);
    });
  }
  return { changed, reload, save, test };
}

function serviceActions(editor: DraftState, status: StatusState) {
  function loadOrganizations() {
    void status.run(async () => {
      editor.setOrganizations(
        await dependencies.listIdentityConnectionOrganizations(
          editor.draft.brokerUrl,
        ),
      );
    });
  }
  function connectService() {
    void status.run(async () => {
      const address = dependencies.normalizeSignInService(
        editor.draft.brokerUrl,
      );
      if (!address)
        throw new Error(
          "Use an HTTPS identity service URL, or HTTP loopback for development.",
        );
      dependencies.writeSignInService(address);
      status.setResult("Sign-in service configured");
    });
  }
  function signInService() {
    void status.run(async () => {
      const address = dependencies.normalizeSignInService(
        editor.draft.brokerUrl,
      );
      if (
        !address ||
        address !==
          dependencies.normalizeSignInService(dependencies.readSignInService())
      )
        throw new Error(
          "Connect this sign-in service before signing in to it.",
        );
      const returnTo =
        window.location.pathname +
        window.location.search +
        window.location.hash;
      await dependencies.beginSignIn(dependencies.brokeredRealmUpstream(), {
        prompt: "login",
        returnTo,
      });
    });
  }
  return { loadOrganizations, connectService, signInService };
}

function useIdentityAuthentication(
  editor: DraftState,
  status: StatusState,
  props: IdentityConnectionPanelProps,
) {
  const [confirming, setConfirming] = useState(false);
  async function signIn(credentials?: IdentityConnectionCredentials) {
    await status.run(async () => {
      if (!editor.saved) return;
      await dependencies.beginIdentityConnectionSignIn(
        editor.saved.connectionId,
        { credentials },
      );
      status.setResult("Signed in");
      props.onChanged();
    });
  }
  async function remove() {
    if (!editor.saved) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    await status.run(async () => {
      await dependencies.removeIdentityConnection(
        editor.saved?.connectionId ?? "",
      );
      editor.setSaved(null);
      editor.setDraft(dependencies.identityConnectionDraft(props.provider.id));
      setConfirming(false);
      status.setResult("Identity configuration removed");
      props.onChanged();
    });
  }
  return { signIn, remove, confirming, setConfirming };
}

export function useIdentityConnection(props: IdentityConnectionPanelProps) {
  const editor = useIdentityDraft(
    props.provider,
    props.connection,
    props.initialOidcTransport,
  );
  const status = useIdentityStatus(props.onFlash);
  const authentication = useIdentityAuthentication(editor, status, props);
  return {
    ...editor,
    ...status,
    ...configurationActions(editor, status, props),
    ...serviceActions(editor, status),
    ...authentication,
  };
}
export type IdentityConnectionEditor = ReturnType<typeof useIdentityConnection>;
