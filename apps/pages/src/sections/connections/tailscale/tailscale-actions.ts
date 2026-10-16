import {
  importTailscaleAppResponse,
  tailscaleKeyHandoff,
} from "@opensesame/app-core/lib/tailscale/artifacts.js";
import {
  tailscaleAppName,
  tailscaleOAuthAppClient,
} from "@opensesame/app-core/lib/tailscale/oauth-app.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
import type { TailscaleState } from "./useTailscaleState.js";
export type TailscaleAction =
  | "register"
  | "provision"
  | "forget"
  | "import"
  | "handoff";
function actionContext(
  model: TailscaleState,
  action: TailscaleAction,
  controller: AbortController,
  currentTurn: number,
) {
  const base = deps.transport();
  const vault = deps.session();
  try {
    const capturedApp =
      action === "provision" && model.saved
        ? deps.openTailscaleApp(model.saved, vault.current().tomb)
        : null;
    const check = () => {
      controller.signal.throwIfAborted();
      if (model.turn.current !== currentTurn)
        throw new Error("Tailscale configuration changed.");
      if (vault.current().guest)
        throw new Error("Create your own vault first.");
      base.assertCurrent();
      if (action === "provision" && model.saved) {
        deps.assertTailscaleAppCurrent(model.saved);
        if (
          deps.openTailscaleApp(model.saved, vault.current().tomb)
            .clientSecret !== capturedApp?.clientSecret
        )
          throw new Error("The Tailscale app credential changed.");
      }
    };
    const transport = { fetch: base.fetch, assertCurrent: check };
    return {
      capturedApp,
      check,
      vault,
      controller,
      api: tailscaleOAuthAppClient(
        model.saved ?? { ...model.draft, redirectUri: deps.redirectUri() },
        transport,
      ),
    };
  } catch (error) {
    vault.close();
    throw error;
  }
}
async function register(
  model: TailscaleState,
  ctx: ReturnType<typeof actionContext>,
) {
  if (model.saved) throw new Error("This app is already registered.");
  const tomb = ctx.vault.current().tomb;
  let retained: ReturnType<typeof deps.readTailscaleApp> = null;
  const app = await ctx.api.register(
    model.adminToken,
    async (created) => {
      retained = await deps.saveTailscaleApp(
        ctx.api.config,
        created,
        tomb,
        ctx.check,
      );
      ctx.check();
      model.setSaved(retained);
    },
    ctx.controller.signal,
  );
  if (
    !retained ||
    deps.openTailscaleApp(retained, tomb).clientSecret !== app.clientSecret
  )
    throw new Error("The Tailscale app credential changed.");
  await ctx.api.verify(app, model.adminToken, ctx.controller.signal);
  if (deps.openTailscaleApp(retained, tomb).clientSecret !== app.clientSecret)
    throw new Error("The Tailscale app credential changed.");
  ctx.check();
  model.setResult("OAuth app registered and verified by the configured API.");
}
async function execute(
  model: TailscaleState,
  action: TailscaleAction,
  ctx: ReturnType<typeof actionContext>,
) {
  ctx.check();
  const tomb = ctx.vault.current().tomb;
  if (action === "register") return register(model, ctx);
  if (action === "import") {
    if (model.saved)
      throw new Error("Remove the existing app before replacing it.");
    const app = importTailscaleAppResponse(model.appResponse, ctx.api.config);
    const retained = await deps.saveTailscaleApp(
      ctx.api.config,
      app,
      tomb,
      ctx.check,
    );
    ctx.check();
    model.setSaved(retained);
    model.setResult(
      "App credentials saved in this vault. Vendor verification is pending.",
    );
  } else if (action === "handoff") {
    model.setKey(tailscaleKeyHandoff(model.deviceKey));
    model.setResult(
      "Device key ready for handoff. Validity, expiry and device enrollment are unverified.",
    );
  } else if (model.saved && action === "provision") {
    const issued = await ctx.api.provision(
      ctx.capturedApp ?? deps.openTailscaleApp(model.saved, tomb),
      deps.browser(),
      ctx.controller.signal,
    );
    ctx.check();
    model.setKey(issued);
    model.setResult(
      "Single-use device auth key issued by the configured API. Enroll the target device with its Tailscale client.",
    );
  } else if (model.saved && action === "forget") {
    await deps.forgetTailscaleApp(model.saved, tomb, ctx.check);
    ctx.check();
    model.setSaved(null);
    model.setDraft((current) => ({ ...current, name: tailscaleAppName() }));
    model.setResult(
      "Local configuration removed. Revoke an unused app in the Tailscale admin console.",
    );
  }
}
async function executeGuarded(
  model: TailscaleState,
  action: TailscaleAction,
  controller: AbortController,
  currentTurn: number,
) {
  const ctx = actionContext(model, action, controller, currentTurn);
  try {
    await execute(model, action, ctx);
  } finally {
    ctx.vault.close();
  }
}
function failureMessage(action: TailscaleAction): string {
  return action === "register"
    ? "Tailscale registration or verification failed. Check API permissions and browser CORS access. Hosted Tailscale endpoints currently refuse this app origin. Use the registration artifact and returned credentials; no backend or extension is used. If creation reached Tailscale, inspect its OAuth apps before retrying."
    : "Tailscale did not complete this operation. Check the owning vault, returned credentials, consent and direct API browser access. Imported credentials and device keys are unverified until the provider confirms them.";
}
export function runTailscaleAction(
  model: TailscaleState,
  action: TailscaleAction,
  onChanged: () => void,
  onFlash: (flash: Flash) => void,
) {
  if (model.busy || !model.ready || model.abort.current) return;
  const currentTurn = ++model.turn.current;
  const controller = new AbortController();
  model.abort.current = controller;
  model.setBusy(true);
  model.setFailure("");
  model.setResult("");
  model.setKey(null);
  let releasePopup: (() => void) | undefined;
  try {
    if (action === "provision")
      releasePopup = deps.browser().prepareAuthorization?.();
  } catch {
    controller.abort();
    if (model.abort.current === controller) model.abort.current = null;
    model.setBusy(false);
    model.setFailure("Could not open Tailscale authorization.");
    return;
  }
  void executeGuarded(model, action, controller, currentTurn)
    .catch(() => {
      if (model.turn.current !== currentTurn) return;
      const message = failureMessage(action);
      model.setFailure(message);
      onFlash({ tone: "err", text: message });
    })
    .finally(() => {
      releasePopup?.();
      if (model.abort.current === controller) {
        model.abort.current = null;
        model.setBusy(false);
      }
      if (model.turn.current !== currentTurn) return;
      model.setAdminToken("");
      model.setAppResponse("");
      model.setDeviceKey("");
      if (["register", "import", "forget"].includes(action)) onChanged();
    });
}
