/**
 * The Host's executor, as the pact tests need it: `run_change_password`'s
 * ordering (`crates/rotation-web/src/executor.rs`) issued as step requests
 * through the fake Host. Each dispatch checks the run's control state first,
 * as the Host's `ControlGate` does, and sends nothing while a person holds the
 * page.
 */
import type { RunnerStepOutcome } from "@opensesame/api-client";
import type { JsonObject } from "@opensesame/os-domain";
import type { FakeHost } from "./fake-host";

export interface Recipe {
  changeUrl: string;
  currentSelector?: string;
  newSelector: string;
  confirmSelector?: string;
  submitSelector: string;
}

export type Ended =
  | { kind: "completed" }
  | { kind: "blocked"; why: string }
  | { kind: "reconcile"; why: string };

export interface Walk {
  ended: Ended;
  /** The step tags dispatched, in order. */
  steps: string[];
  handle: string | null;
}

/** A step that did not go the way the ordering needs: the walk ends here. */
class Stop extends Error {
  constructor(readonly ended: Ended) {
    super(ended.kind);
  }
}

type Tag = RunnerStepOutcome["outcome"];

function is<T extends Tag>(
  outcome: RunnerStepOutcome,
  tag: T,
): outcome is Extract<RunnerStepOutcome, { outcome: T }> {
  return outcome.outcome === tag;
}

const blocked = (why: string): Ended => ({ kind: "blocked", why });
const reconcile = (why: string): Ended => ({ kind: "reconcile", why });

/** The ways the walk talks to the Host: send a step, insist on its answer, fill a field. */
function dispatcher(host: FakeHost, runId: string, steps: string[]) {
  const send = async (request: JsonObject): Promise<RunnerStepOutcome> => {
    const run = await host.getRun(runId);
    if (run.control_state !== "agent_driving" || run.driver !== "agent") {
      throw new Stop(blocked("human_driving"));
    }
    steps.push(String(request.step));
    const outcome = await host.dispatch(runId, request);
    if (outcome === null) throw new Stop(blocked("transport"));
    return outcome;
  };
  /** Send `request`; the walk ends as `otherwise` unless it is answered `tag`. */
  const need = async <T extends Tag>(
    request: JsonObject,
    tag: T,
    otherwise: Ended,
  ) => {
    const outcome = await send(request);
    if (!is(outcome, tag)) throw new Stop(otherwise);
    return outcome;
  };
  const fill = async (reference: string, selector: string | undefined) => {
    if (!selector) return;
    const landed = await need(
      { step: "fill_credential", reference, selector },
      "filled",
      blocked("fill"),
    );
    if (landed.filled !== "Ok") throw new Stop(blocked("recipe_drift"));
  };
  return { need, fill };
}

export async function changePassword(
  host: FakeHost,
  runId: string,
  recipe: Recipe,
  handle = `candidate:${crypto.randomUUID()}`,
): Promise<Walk> {
  const steps: string[] = [];
  const { need, fill } = dispatcher(host, runId, steps);

  const walk = async (): Promise<Ended> => {
    await need(
      { step: "navigate", url: recipe.changeUrl },
      "done",
      blocked("navigate"),
    );
    await need(
      { step: "wait_for", selector: recipe.newSelector },
      "done",
      blocked("wait"),
    );
    await need(
      { step: "generate_candidate", handle },
      "done",
      blocked("generate"),
    );
    const backup = blocked("backup_not_acknowledged");
    const sealed = await need(
      { step: "seal_candidate", handle },
      "sealed",
      backup,
    );
    if (!sealed.backed_up) throw new Stop(backup);
    await fill("current_password", recipe.currentSelector);
    await fill(handle, recipe.newSelector);
    await fill(handle, recipe.confirmSelector);
    const absent = blocked("candidate_absent");
    const present = await need(
      {
        step: "assert_present",
        reference: handle,
        selector: recipe.newSelector,
      },
      "presence",
      absent,
    );
    if (present.presence !== "Present") throw new Stop(absent);
    await need(
      { step: "submit", selector: recipe.submitSelector },
      "done",
      reconcile("submit_unknown"),
    );
    const unconfirmed = reconcile("fresh_login_did_not_confirm");
    const proof = await need(
      { step: "verify_login", reference: handle },
      "verified",
      unconfirmed,
    );
    if (proof.verified !== "Works") throw new Stop(unconfirmed);
    await need(
      { step: "promote_candidate", handle },
      "done",
      reconcile("promotion_not_acknowledged"),
    );
    return { kind: "completed" };
  };

  let ended: Ended;
  try {
    ended = await walk();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    ended = error.ended;
  }
  host.close(runId);
  return { ended, steps, handle };
}

export const RECIPE: Recipe = {
  changeUrl: "https://rp.example/account/password",
  currentSelector: "#current",
  newSelector: "#new",
  confirmSelector: "#confirm",
  submitSelector: "#go",
};
