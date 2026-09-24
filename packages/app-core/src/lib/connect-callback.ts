import { env } from "../host.js";
import { maybePage } from "../ports.js";
/**
 * Where Connect OAuth authorizations return: the relay in
 * `apps/pages/server`, deployed as `apps/pages/api` beside the app.
 *
 * A destination, never a credential: Connect returns the browser to the
 * relay after approval and the relay bounces it to the app. Empty means
 * authorizations complete without a callback leg. Build-time
 * (`VITE_CONNECT_CALLBACK_BASE`), deploy-time (`os-runtime-config.json`
 * `connectCallbackBase`), nothing persisted — an operator address, not a
 * vault value. `/` means this page's own origin: the deployment that serves
 * the app serves the relay too.
 */

function built(): string {
  return env().VITE_CONNECT_CALLBACK_BASE?.trim() || "";
}

let deployed = "";

/** Deploy-time override from `os-runtime-config.json`. */
export function applyConnectCallbackBase(value: string | undefined): void {
  deployed = value?.trim() || "";
}

/** The relay base, or "" where authorizations skip the callback leg. */
export function connectCallbackBase(
  origin: string = maybePage()?.location.origin ?? "",
): string {
  const base = deployed || built();
  return base === "/" ? origin : base;
}
