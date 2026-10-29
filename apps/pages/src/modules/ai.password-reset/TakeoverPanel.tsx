import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  IconCheck,
  IconPause,
  IconPlay,
  IconRefresh,
  IconUser,
  IconX,
} from "../../components/Icons.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import {
  type AgentRun,
  type ClaimedStep,
  type HookRecord,
  type TakeoverClient,
  createHostTakeoverClient,
  expectedOutcome,
  takeoverActions,
} from "./takeover-client.js";

const STATE_WORDS: Record<string, string> = {
  awaiting_human: "Parked — waiting for you",
  handoff_requested: "Handoff requested — the agent is parking",
  suspended: "Suspended — take over to re-attach",
  human_driving: "You are driving",
  resume_requested: "Handed back — the agent is re-checking the page",
  agent_driving: "The agent is driving",
};

type Act = (run: () => Promise<unknown>) => Promise<void>;

function useTakeoverRun(client: TakeoverClient, runId: string) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [records, setRecords] = useState<HookRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useFailureNotice(`takeover-${runId}`, "Browser takeover", error);
  const refresh = useCallback(async () => {
    try {
      const [next, nextRecords] = await Promise.all([
        client.getRun(runId),
        client.listHookRecords(runId),
      ]);
      if (next.id !== runId) return;
      setRun(next);
      setRecords(nextRecords);
      setError(null);
    } catch {
      setError("The run could not be reached on the Host.");
    }
  }, [client, runId]);
  useEffect(() => {
    setRun(null);
    setRecords([]);
    setError(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act: Act = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "That did not go through.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { run, records, error, busy, act };
}

function ControlButtons(props: {
  run: AgentRun;
  busy: boolean;
  act: Act;
  client: TakeoverClient;
  runId: string;
}) {
  const actions = takeoverActions(props.run);
  const { act, client, runId } = props;
  return (
    <div className="keyed-row">
      {actions.includes("handoff") ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Request handoff"
          title="Request handoff"
          disabled={props.busy}
          onClick={() => void act(() => client.requestHandoff(runId))}
        >
          <IconPause size={18} />
        </button>
      ) : null}
      {actions.includes("take") ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Take over"
          title="Take over"
          disabled={props.busy}
          onClick={() => void act(() => client.takeControl(runId))}
        >
          <IconUser size={18} />
        </button>
      ) : null}
      {actions.includes("release") ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Hand back & resume"
          title="Hand back & resume"
          disabled={props.busy}
          onClick={() => void act(() => client.release(runId))}
        >
          <IconPlay size={18} />
        </button>
      ) : null}
    </div>
  );
}

function ClaimedStepCard(props: {
  step: ClaimedStep;
  busy: boolean;
  settle: (outcome: { outcome: string; error?: string }) => void;
}) {
  const expected = expectedOutcome(props.step.request.step);
  return (
    <div>
      <p>
        Step {props.step.seq}: {props.step.request.step ?? "step"}
        {props.step.request.selector ? ` · ${props.step.request.selector}` : ""}
        {props.step.request.url ? ` · ${props.step.request.url}` : ""}
      </p>
      <div className="keyed-row">
        {expected === "done" ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="I did this"
            title="I did this"
            disabled={props.busy}
            onClick={() => props.settle({ outcome: "done" })}
          >
            <IconCheck size={18} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          aria-label="I can't do this"
          title="I can't do this"
          disabled={props.busy}
          onClick={() =>
            props.settle({ outcome: "failed", error: "challenge" })
          }
        >
          <IconX size={18} />
        </button>
      </div>
      {expected !== null && expected !== "done" ? (
        <p>
          This step expects a {expected} result from the page driver; this panel
          never invents one.
        </p>
      ) : null}
    </div>
  );
}

function HumanDriving(props: {
  busy: boolean;
  act: Act;
  client: TakeoverClient;
  runId: string;
}) {
  const [step, setStep] = useState<ClaimedStep | null>(null);
  const { act, client, runId } = props;
  return (
    <>
      <p>
        The browser session is yours — the agent cannot drive while you hold it.
        Complete the challenge in the live session, then hand back. Anything you
        do is recorded as your segment of the ceremony; passwords are never
        shown or stored here.
      </p>
      {step === null ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Check for a step"
          title="Check for a step"
          disabled={props.busy}
          onClick={() =>
            void act(async () => setStep(await client.claimStep(runId)))
          }
        >
          <IconRefresh size={18} />
        </button>
      ) : (
        <ClaimedStepCard
          step={step}
          busy={props.busy}
          settle={(outcome) =>
            void act(async () => {
              await client.settleStep(runId, step.seq, outcome);
              setStep(null);
            })
          }
        />
      )}
    </>
  );
}

function RunRecords({ records }: { records: HookRecord[] }) {
  if (records.length === 0) return null;
  return (
    <>
      <h2>Run record</h2>
      <ul>
        {records.map((record) => (
          <li key={record.sequence}>
            {record.interception_point} · {record.decision}
            {record.reason ? ` · ${record.reason}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Takeover for one agent run: the notice's Take over route. The person
 * step-up verifies, takes the control lease (the agent parks and cannot
 * drive), completes the challenge in the live browser session, answers any
 * step the run hands them, then releases the page so the runner re-asserts
 * and resumes the ceremony.
 */
export function TakeoverPanel({
  client: provided,
}: {
  client?: TakeoverClient;
}) {
  const { runId = "" } = useParams();
  const clientRef = useRef<TakeoverClient | null>(null);
  clientRef.current ??= provided ?? createHostTakeoverClient();
  const client = clientRef.current;
  const { run, records, busy, act } = useTakeoverRun(client, runId);
  if (!run) {
    return (
      <section aria-label="Browser takeover">
        <h1>Browser takeover</h1>
        <p>Loading the run…</p>
      </section>
    );
  }
  return (
    <section aria-label="Browser takeover">
      <h1>Browser takeover</h1>
      <p>
        {run.origin ?? "Provider site"} ·{" "}
        {STATE_WORDS[run.control_state] ?? run.control_state}
        {run.blocked_reason ? ` · ${run.blocked_reason}` : ""}
      </p>
      <ControlButtons
        run={run}
        busy={busy}
        act={act}
        client={client}
        runId={runId}
      />
      {run.control_state === "human_driving" ? (
        <HumanDriving
          key={runId}
          busy={busy}
          act={act}
          client={client}
          runId={runId}
        />
      ) : null}
      <RunRecords records={records} />
    </section>
  );
}
