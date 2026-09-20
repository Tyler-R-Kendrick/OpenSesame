/**
 * Where Connect OAuth authorizations return (`apps/connect-backend`).
 *
 * A destination, never a credential: Connect returns the browser to the
 * relay after approval and the relay bounces it to the app. Empty means
 * authorizations complete without a callback leg. Build-time
 * (`VITE_CONNECT_CALLBACK_BASE`), deploy-time (`os-runtime-config.json`
 * `connectCallbackBase`), nothing persisted — an operator address, not a
 * vault value.
 */

const built = import.meta.env.VITE_CONNECT_CALLBACK_BASE?.trim() || "";

let deployed = "";

/** Deploy-time override from `os-runtime-config.json`. */
export function applyConnectCallbackBase(value: string | undefined): void {
  deployed = value?.trim() || "";
}

/** The relay base, or "" where authorizations skip the callback leg. */
export function connectCallbackBase(): string {
  return deployed || built;
}
