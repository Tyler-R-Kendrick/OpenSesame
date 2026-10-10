/**
 * Start a recovery (ADR 0186 §10): the recipient picks the recovery file the
 * circle's owner saved, sees what it is from the owner's signed policy, names
 * this device, and sends the request. Nothing is sent anywhere: the request is
 * a packet the next sheet offers to copy, to hand to each contact.
 *
 * The file is read here and checked by the desk; a file that is not a
 * recovery file, or whose policy does not verify, is a mark on its key and a
 * notice in the tray, and the previous file is let go.
 */

import {
  type BundleView,
  type RecoveryView,
  readBundle,
  startRecoveryFlow,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import { useRef, useState } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconShield } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useFocusAfter } from "../../../lib/use-focus-after.js";
import { useCeremonyFailure } from "../failure-text.js";
import { FileIn } from "../packet-field.js";
import type { Desk } from "../use-desk.js";

/** What the device's label may be: the request holds it as a label of at most this many characters. */
export const DEVICE_LABEL_MAX = 120;
const DEFAULT_DEVICE = "This device";

type Loaded = Readonly<{ text: string; view: BundleView }>;

/** What the file says, all of it from the owner's signed policy. */
function factsOf(view: BundleView) {
  const { policy } = view.signedPolicy;
  return [
    { key: "Protects", value: view.collection },
    { key: "Rule", value: view.rule },
    { key: "Contacts", value: view.guardians.join(", ") },
    { key: "Epoch", value: String(view.epoch) },
    { key: "Owner key", value: keyFingerprint(policy.ownerKey) },
  ];
}

/** The file chosen, the name for this device, and the one step that sends the request. */
function useStart(
  desk: Desk,
  onStarted: (view: RecoveryView) => Promise<void>,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [device, setDevice] = useState(DEFAULT_DEVICE);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:recovery-start",
    "Start a recovery",
  );
  const sendKey = useRef<HTMLButtonElement>(null);
  const land = useFocusAfter(busy);
  const label = device.trim();
  const tooLong = label.length > DEVICE_LABEL_MAX;
  const ready = loaded !== null && label !== "" && !tooLong && !busy;

  async function send(): Promise<void> {
    if (!loaded || !ready) return;
    setBusy(true);
    const done = await failure.run(() =>
      startRecoveryFlow(desk.ports, {
        bundleText: loaded.text,
        recipientLabel: label,
      }),
    );
    if (done.ok) await onStarted(done.value);
    else land(() => sendKey.current);
    setBusy(false);
  }

  return {
    loaded,
    device,
    busy,
    tooLong,
    ready,
    sendKey,
    failure: failure.message,
    send,
    choose: async (text: string) => {
      // A file that is refused does not leave the one before it standing.
      setLoaded(null);
      failure.clear();
      setLoaded({ text, view: readBundle(text) });
    },
    rename: (next: string) => {
      setDevice(next);
      failure.clear();
    },
  };
}

export function StartSheet({
  desk,
  onStarted,
  onClose,
}: {
  desk: Desk;
  /** The request is raised and kept; the panel moves on to its sheet. */
  onStarted: (view: RecoveryView) => Promise<void>;
  onClose: () => void;
}) {
  const start = useStart(desk, onStarted);
  const { loaded } = start;
  return (
    <CeremonySheet
      title="Start a recovery"
      mark={<IconShield size={20} />}
      onClose={onClose}
    >
      <form
        aria-label="Start a recovery"
        onSubmit={(event) => {
          event.preventDefault();
          void start.send();
        }}
      >
        <CeremonyShell
          name={loaded ? loaded.view.label : "Recovery file"}
          facts={loaded ? factsOf(loaded.view) : undefined}
          primary={{
            label: "Send the request",
            submit: true,
            busy: start.busy,
            disabled: !start.ready,
            keyRef: start.sendKey,
            onClick: () => void start.send(),
          }}
        >
          <FileIn
            id="recovery-file"
            label="The recovery file"
            failureId="trusted-contacts:recovery-file"
            failureTitle="The recovery file"
            onText={start.choose}
          />
          <FieldShell
            id="recovery-device"
            label="Name this device"
            autoComplete="off"
            value={start.device}
            readOnly={start.busy}
            onValueChange={start.rename}
            status={
              start.tooLong ? (
                <StatusMark
                  tone="err"
                  label={`At most ${DEVICE_LABEL_MAX} characters.`}
                />
              ) : null
            }
          />
          {start.failure ? (
            <div className="actions">
              <StatusMark tone="err" label={start.failure} />
            </div>
          ) : null}
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
