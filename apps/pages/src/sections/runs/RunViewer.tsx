import { useCallback, useEffect, useState } from "react";
import {
  type AgentRun,
  type LogEntry,
  agentRunSeams,
  canRequestHandoff,
  canTakeControl,
  runSentence,
} from "../../lib/agent-runs.js";

/** How often the viewer asks for new entries while a run is open. */
const TAIL_MS = 1_000;

const LANE_LABEL = {
  action: "did",
  thought: "thinking",
  frame: "screen",
} as const satisfies Record<LogEntry["lane"], string>;

/**
 * Rationale text, rendered inert.
 *
 * The thought lane is downstream of a page OpenSesame does not control, so a
 * relying party can put text into it and have that text appear here, inside
 * our own chrome, beside real controls (ADR 0081 §4). Three things keep that
 * from being a phishing surface, and all three are visible in this component:
 * it renders as text into a quoted region, it is never a link and never
 * markup, and it is labelled as the model talking rather than as the product.
 *
 * The fourth lives at capture, in `UntrustedText`, where bidirectional
 * overrides and control characters are stripped before the entry is sealed —
 * because a render-time filter would mean the unstripped form exists.
 */
function Rationale({ text }: { text: string }) {
  return (
    <q className="run-lane__thought" lang="und" translate="no">
      {text}
    </q>
  );
}

/** One entry, as the person sees it. */
function Entry({ entry, body }: { entry: LogEntry; body: string | null }) {
  return (
    <li className={`run-lane run-lane--${entry.lane}`}>
      <span className="run-lane__seq">{entry.seq}</span>
      <span className="run-lane__kind">{LANE_LABEL[entry.lane]}</span>
      <span className="run-lane__body">
        {body === null ? (
          <span className="run-lane__sealed">
            Sealed — unlock your vault to read this
          </span>
        ) : entry.lane === "thought" ? (
          <Rationale text={body} />
        ) : (
          body
        )}
      </span>
      <time className="run-lane__at" dateTime={entry.recordedAt}>
        {entry.recordedAt.slice(11, 19)}
      </time>
    </li>
  );
}

/**
 * Watch one run, and take the page.
 *
 * `open` decrypts one sealed entry, or returns null when the vault is locked.
 * It is injected rather than imported so this component stays a view: the
 * viewer key is the vault's, and the decision about whether it is available is
 * made where the vault is.
 */
export function RunViewer({
  runId,
  open,
}: {
  runId: string;
  open: (entry: LogEntry) => string | null;
}) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [current, page] = await Promise.all([
      agentRunSeams.readRun(runId),
      agentRunSeams.readLog(runId, cursor),
    ]);
    setRun(current);
    if (page.entries.length > 0) {
      setEntries((held) => [...held, ...page.entries]);
      setCursor(page.nextAfter);
    }
  }, [runId, cursor]);

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (!live) return;
      void refresh();
    };
    tick();
    const timer = window.setInterval(tick, TAIL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  // Generic in what the ceremony returns, and the result is deliberately
  // discarded: every ceremony here is followed by a refresh, so the run is
  // re-read from the gateway rather than patched from a return value that
  // could disagree with it.
  async function guard<T>(work: () => Promise<T>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (run === null) {
    return <p className="note">Loading this run…</p>;
  }

  const thoughts = entries.filter((entry) => entry.lane === "thought").length;

  return (
    <section className="run">
      <header className="run__head">
        <h2 className="run__origin">{run.origin}</h2>
        <p className="run__state">{runSentence(run)}</p>
        {run.blockedReason !== null && (
          <p className="note note--warn">{run.blockedReason}</p>
        )}
      </header>

      {run.tier === "t3" && (
        <p className="run__tier">
          Running from a saved recipe — no model is involved, so there is
          nothing on the thinking lane.
        </p>
      )}
      {run.tier === "t4" && thoughts > 0 && (
        <p className="run__tier">
          The thinking lane is the model narrating. What it actually did is the
          “did” lane.
        </p>
      )}

      <ol className="run-log">
        {entries.map((entry) => (
          <Entry key={entry.seq} entry={entry} body={open(entry)} />
        ))}
      </ol>
      {entries.length === 0 && (
        <p className="note">Nothing recorded on this run yet.</p>
      )}

      {notice !== null && <p className="note">{notice}</p>}

      <div className="run__do">
        {canRequestHandoff(run) && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || run.handoffQueued}
            onClick={() =>
              void guard(async () => {
                const outcome = await agentRunSeams.requestHandoff(run.id);
                setNotice(
                  outcome === "queued"
                    ? "Queued — it is mid-save and will hand over when that finishes."
                    : "Asked. It will hand over at its next step.",
                );
              }, "Asked for the page.")
            }
          >
            Ask for the page
          </button>
        )}
        {canTakeControl(run) && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() =>
              void guard(
                () => agentRunSeams.takeControl(run.id),
                "You have the page.",
              )
            }
          >
            Take the page
          </button>
        )}
        {run.controlState === "human_driving" && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void guard(
                () => agentRunSeams.releaseControl(run.id),
                "Handed back. It will check the page before carrying on.",
              )
            }
          >
            Hand it back
          </button>
        )}
      </div>
    </section>
  );
}
