import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useModalFocus } from "../../../lib/modal-focus.js";
import { releaseDownloads } from "../../../lib/sops/download.js";
import { sopsSession } from "../../../lib/sops/session.js";
import { SopsWorkflow } from "../../../lib/sops/workflow.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { SopsDocumentView } from "./SopsDocumentView.js";
import { loadVaultIdentities, loadVaultRecipients } from "./identities.js";
import { notice, useSopsDocumentActions } from "./useSopsDocument.js";

export function SopsDocumentSheet({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const vault = useVault();
  const workflow = useMemo(() => new SopsWorkflow(sopsSession), []);
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const [identity, setIdentity] = useState("");
  const [recipients, setRecipients] = useState("");
  const [threshold, setThreshold] = useState("");
  const [vaultIdentities, setVaultIdentities] = useState<readonly string[]>([]);
  const [vaultRecipients, setVaultRecipients] = useState<readonly string[]>([]);

  const { status, guest, awaitingSecondStep, tomb } = vault;
  const scope = status === "unlocked" ? tomb : null;

  useEffect(() => {
    let live = true;
    const access = { status, guest, awaitingSecondStep, tomb };
    void loadVaultIdentities(access).then((found) => {
      if (live) setVaultIdentities(found);
    });
    void loadVaultRecipients(access).then((found) => {
      if (live) setVaultRecipients(found);
    });
    return () => {
      live = false;
    };
  }, [status, guest, awaitingSecondStep, tomb]);

  // Closing the sheet drops the editor, the verified handle behind it, and
  // any object URL a download left live.
  useEffect(
    () => () => {
      workflow.close();
      releaseDownloads();
    },
    [workflow],
  );

  // Lock, logout, guest entry, and a vault switch each invalidate the
  // engine's handles; clear the editor and the typed identity to match.
  // The scope string carries all three, so a switch that stays unlocked is
  // caught as surely as a lock.
  const sessionScope = `${status}:${guest ? "guest" : "account"}:${tomb}`;
  const lastScope = useRef(sessionScope);
  useEffect(() => {
    if (lastScope.current === sessionScope) return;
    lastScope.current = sessionScope;
    workflow.close();
    setIdentity("");
  }, [sessionScope, workflow]);

  useEffect(() => {
    if (state.failure) notice("err", state.failure.message);
  }, [state.failure]);

  const actions = useSopsDocumentActions({
    workflow,
    state,
    identity,
    recipients,
    threshold,
    vaultIdentities,
    scope,
  });

  return (
    <SopsDocumentView
      state={state}
      sheetRef={sheetRef}
      closeRef={closeRef}
      identity={identity}
      recipients={recipients}
      threshold={threshold}
      vaultIdentities={vaultIdentities.length}
      vaultRecipients={vaultRecipients}
      canOpen={
        state.phase !== "empty" &&
        (identity.trim() !== "" || vaultIdentities.length > 0)
      }
      onClose={() => {
        workflow.close();
        releaseDownloads();
        onClose();
      }}
      onFile={(file) => {
        void file
          .text()
          .then((text) => workflow.selectDocument(file.name, text));
      }}
      setIdentity={setIdentity}
      setRecipients={setRecipients}
      setThreshold={setThreshold}
      setEdited={(text) => workflow.setEdited(text)}
      {...actions}
    />
  );
}
