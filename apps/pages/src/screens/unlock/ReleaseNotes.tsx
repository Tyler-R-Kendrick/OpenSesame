import { forwardRef, useState } from "react";
import { version } from "../../../package.json";
import {
  IconCheck,
  IconChevronRight,
  IconClock,
  IconX,
} from "../../components/Icons.js";

/**
 * Release notes beside the gate: what a person can do in this build, what
 * is still unfinished, and what bites today. User-facing only — feature and
 * UI impact, never plane names, ADRs, or implementer jargon. Shown on the
 * front door and the unlock form, never past them.
 *
 * One accordion row per build. On wide layouts the newest opens on arrival
 * (lock-v5 desktop). On narrow, all rows start collapsed so the corner dial
 * keeps the empty band under the opaque notes (lock-v5 mobile).
 */

type ReleaseNote = {
  readonly version: string;
  readonly works: readonly string[];
  readonly inProgress: readonly string[];
  readonly knownIssues: readonly string[];
};

const RELEASES: readonly ReleaseNote[] = [
  {
    version,
    works: [
      "Continue as guest, or sign in with Google — you can start without an account",
      "Unlock with a passkey or PIN; optional authenticator code as step 2",
      "Store accounts, cards, notes, and secrets on this device",
      "Create certificates in the vault without leaving the app",
      "Open on the front door: set up your own vault, or join somebody's live session",
      "Live sessions pair browsers directly, or through a tunnel address, TURN server or code carrier the owner names",
      "Connect services from Connections; GitHub can back up your vault",
      "Generate passwords and authenticator codes inside the app",
    ],
    inProgress: [
      "More connectors from the catalog will finish linking the way GitHub does today",
      "Sharing access and approvals with people and agents is still being finished",
      "Clearing leftover setup screens and wording from older builds",
    ],
    knownIssues: [
      "Some connectors look ready but stop before the link finishes",
      "Sign-in may need the popup or follow-up link on this same device",
      "Older server-address settings are ignored — use Connections instead",
    ],
  },
  {
    version: "0.0.1",
    works: [
      "Sealed vault on this device",
      "Continue as guest from the sign-in screen",
    ],
    inProgress: ["Connections and GitHub backup still landing"],
    knownIssues: ["Setup still showed leftover wording from older builds"],
  },
];

function NoteList({
  items,
  Icon,
  label,
}: {
  items: readonly string[];
  Icon: typeof IconCheck;
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="unlock__notes-section" aria-label={label}>
      <h3 className="unlock__notes-head">{label}</h3>
      <ul className="unlock__notes-list">
        {items.map((line) => (
          <li key={line}>
            <Icon className="unlock__notes-mark" size={14} />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReleasePanel({
  release,
  newest,
  open,
  onToggle,
}: {
  release: ReleaseNote;
  newest: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const label = newest ? `Release notes · ${release.version}` : release.version;
  const panelId = `unlock-notes-${release.version}`;
  return (
    <div
      className={
        open
          ? "unlock__notes-release unlock__notes-release--open"
          : "unlock__notes-release"
      }
    >
      <button
        type="button"
        className="unlock__notes-summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className="unlock__notes-summary-label">{label}</span>
        <IconChevronRight className="unlock__notes-caret" size={12} />
      </button>
      {open ? (
        <section className="unlock__notes-body" id={panelId}>
          <NoteList label="Works" items={release.works} Icon={IconCheck} />
          <NoteList
            label="In progress"
            items={release.inProgress}
            Icon={IconClock}
          />
          <NoteList
            label="Known issues"
            items={release.knownIssues}
            Icon={IconX}
          />
        </section>
      ) : null}
    </div>
  );
}

function initialOpenVersion(): string | null {
  // Narrow: collapsed accordion — empty band for the corner dial.
  // matchMedia is absent in some test hosts; prefer the wide (open) default.
  const mq = globalThis.matchMedia?.("(max-width: 1099px)");
  if (mq?.matches) return null;
  return RELEASES[0]?.version ?? null;
}

export const ReleaseNotes = forwardRef<HTMLElement>(
  function ReleaseNotes(_props, ref) {
    const [active, setActive] = useState<string | null>(initialOpenVersion);
    return (
      <aside ref={ref} className="unlock__notes" aria-label="Release notes">
        <div className="unlock__notes-stack">
          {RELEASES.map((release, index) => (
            <ReleasePanel
              key={release.version}
              release={release}
              newest={index === 0}
              open={active === release.version}
              onToggle={() =>
                setActive((current) =>
                  current === release.version ? null : release.version,
                )
              }
            />
          ))}
        </div>
      </aside>
    );
  },
);
