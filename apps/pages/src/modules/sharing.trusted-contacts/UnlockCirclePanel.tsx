/**
 * Trusted contacts as an unlock policy: choose people from this vault's
 * local directory and how many must authenticate before the vault opens.
 * This is deliberately separate from the old quorum-sharing records; an
 * unlock circle names local identities, not handed-around recovery packets.
 */

import { readLocalPasskeys } from "@opensesame/app-core/lib/local-credentials.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { enrollLocalPasskey } from "@opensesame/app-core/lib/local-passkeys.js";
import {
  type TrustedUnlockPolicy,
  type TrustedUnlockView,
  clearTrustedUnlock,
  readTrustedUnlock,
  trustedUnlockView,
  writeTrustedUnlock,
} from "@opensesame/app-core/lib/trusted-unlock.js";
import { useEffect, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { IconKey } from "../../components/IconKey.js";
import { IconLayers, IconPlus, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { type Person, UnlockCircleFields } from "./UnlockCircleFields.js";
import { PanelFrame, useSaid } from "./panel-frame.js";
import { useDesk } from "./use-desk.js";

/** Replaceable in tests: the vault files behind a circle. */
export const unlockCircleSeams = {
  readPolicy: readTrustedUnlock,
  view: trustedUnlockView,
  writePolicy: writeTrustedUnlock,
  clearPolicy: clearTrustedUnlock,
  directory: readLocalDirectory,
  passkeys: readLocalPasskeys,
  enroll: enrollLocalPasskey,
};

function useUnlockCircle(tomb: string) {
  const [policy, setPolicy] = useState<TrustedUnlockPolicy | null>(null);
  const [view, setView] = useState<TrustedUnlockView | null>(null);
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // The counter is the reload trigger; reading it keeps the dependency.
    void reload;
    let live = true;
    void (async () => {
      try {
        const [nextPolicy, directory, passkeys] = await Promise.all([
          unlockCircleSeams.readPolicy(tomb),
          unlockCircleSeams.directory(tomb),
          unlockCircleSeams.passkeys(tomb),
        ]);
        if (!live) return;
        setPolicy(nextPolicy);
        setPeople(
          directory.entries
            .filter((entry) => entry.kind === "person" && entry.enabled)
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              hasPasskey: passkeys.some((key) => key.principalId === entry.id),
            })),
        );
        setView(
          nextPolicy
            ? await unlockCircleSeams.view(tomb, nextPolicy, [])
            : null,
        );
        setError("");
      } catch (caught) {
        if (live) {
          setError(
            caught instanceof Error
              ? caught.message
              : "The trusted-contact policy could not be read.",
          );
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [tomb, reload]);

  return {
    policy,
    view,
    people,
    error,
    reload: () => setReload((turn) => turn + 1),
  };
}

function EditSheet({
  tomb,
  people,
  policy,
  onClose,
  onSaved,
}: {
  tomb: string;
  people: readonly Person[];
  policy: TrustedUnlockPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(policy?.name ?? "Trusted contacts");
  const [selected, setSelected] = useState<readonly string[]>(
    policy?.memberIds ?? [],
  );
  const [threshold, setThreshold] = useState(
    String(policy?.threshold ?? Math.min(2, people.length || 1)),
  );
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chosen = people.filter((person) => selected.includes(person.id));
  const maximum = chosen.length;
  const wanted = Math.min(Number(threshold) || 1, Math.max(1, maximum));

  async function enroll(person: Person): Promise<void> {
    if (busy || enrolling !== null) return;
    setEnrolling(person.id);
    setError("");
    try {
      const result = await unlockCircleSeams.enroll(tomb, person.id);
      result.vaultOffer?.discard();
      setSelected((current) =>
        current.includes(person.id) ? current : [...current, person.id],
      );
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The passkey could not be enrolled.",
      );
    } finally {
      setEnrolling(null);
    }
  }

  async function save(): Promise<void> {
    if (busy || enrolling !== null || chosen.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await unlockCircleSeams.writePolicy(tomb, {
        name: name.trim() || "Trusted contacts",
        threshold: Math.min(wanted, chosen.length),
        memberIds: chosen.map((person) => person.id),
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The circle could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <CeremonySheet
      title="Trusted contacts"
      mark={<IconLayers size={20} />}
      onClose={onClose}
    >
      <form
        aria-label="Trusted contacts circle"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <UnlockCircleFields
          name={name}
          setName={setName}
          people={people}
          selected={selected}
          setSelected={setSelected}
          maximum={maximum}
          wanted={wanted}
          setThreshold={setThreshold}
          onEnroll={(person) => void enroll(person)}
          enrolling={enrolling}
        />
        {error ? <StatusMark tone="err" label={error} /> : null}
        <div className="actions">
          <button
            type="submit"
            className="go-row"
            disabled={busy || enrolling !== null || chosen.length === 0}
          >
            <span className="go-verb">
              {busy ? "Saving…" : "Save the circle"}
            </span>
          </button>
        </div>
      </form>
    </CeremonySheet>
  );
}

function UnlockCircle({ tomb }: { tomb: string }) {
  const state = useUnlockCircle(tomb);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const newKey = useGuideTarget<HTMLButtonElement>("circle.new");
  const said = useSaid(
    state.view
      ? `${state.view.name}, ${state.view.threshold} of ${state.view.members.length} contacts`
      : "No trusted-contact circle",
  );

  async function remove(): Promise<void> {
    if (!removing) {
      setRemoving(true);
      return;
    }
    try {
      await unlockCircleSeams.clearPolicy(tomb);
      state.reload();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <PanelFrame
      id="circles"
      title="Circles"
      target="settings.trusted-contacts-circles"
      said={said}
      keys={
        <IconKey
          id="circle-new"
          keyRef={newKey}
          small
          label="Start a circle"
          onClick={() => setEditing(true)}
        >
          <IconPlus size={15} />
        </IconKey>
      }
      overlay={
        editing ? (
          <EditSheet
            tomb={tomb}
            people={state.people}
            policy={state.policy}
            onClose={() => setEditing(false)}
            onSaved={state.reload}
          />
        ) : null
      }
    >
      {state.error ? (
        <StatusMark tone="err" label={state.error} />
      ) : state.view ? (
        <div className="tc-row">
          <h3>{state.view.name}</h3>
          <span className="tc-row__facts">
            {state.view.threshold} of {state.view.members.length} contacts must
            approve
          </span>
          <span className="tc-row__facts">
            {state.view.members.map((member) => member.name).join(" · ")}
          </span>
          <IconKey
            small
            label={removing ? "Confirm remove the circle" : "Remove the circle"}
            onClick={() => void remove()}
          >
            <IconTrash size={16} />
          </IconKey>
        </div>
      ) : (
        <StatusMark tone="idle" label="No circles yet." />
      )}
    </PanelFrame>
  );
}

export function UnlockCirclePanel() {
  const desk = useDesk();
  return desk ? <UnlockCircle tomb={desk.ports.tomb} /> : null;
}
