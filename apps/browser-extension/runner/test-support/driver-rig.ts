/** A driver wired to a jsdom page, a vault and a fake Host, for the step-level tests. */
import type { RunnerStepRequest } from "@opensesame/api-client";
import type { DriverDeps } from "../context";
import { runStep } from "../driver";
import { JsdomPages } from "./jsdom-pages";
import { rig } from "./rig";
import { RP } from "./site";

export const RUN = { id: "run:1", origin: RP };

export async function setup(options?: Parameters<typeof rig>[0]) {
  const r = await rig(options);
  const pages = new JsdomPages(r.browser, RP, true);
  const deps: DriverDeps = {
    run: RUN,
    pages,
    vault: r.vault,
    backup: r.host,
    epoch: { epoch: 0, layout: null },
    loginWindowMs: 30,
    waitMs: 30,
  };
  const step = (request: RunnerStepRequest) => runStep(request, deps);
  return { r, pages, deps, step };
}

export async function open(
  step: (r: RunnerStepRequest) => ReturnType<typeof runStep>,
) {
  await step({ step: "navigate", url: `${RP}/account/password` });
}
