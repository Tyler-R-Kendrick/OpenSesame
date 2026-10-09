import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Activation } from "../activation.js";
import { startNativeTwitchValidation } from "./native-twitch-validation-scheduler.js";

function subscribeVisible(listener: () => void): () => void {
  const visible = () => {
    if (document.visibilityState !== "hidden") listener();
  };
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("focus", visible);
  return () => {
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("focus", visible);
  };
}
export function bindNativeTwitchValidation(activation: Activation): void {
  activation.onDispose(
    startNativeTwitchValidation(nativeProviderTransport(), {
      isUnlocked: () => !activation.disposed() && vaultStore.isUnlocked(),
      subscribeUnlock: vaultStore.subscribe,
      subscribeVisible,
    }),
  );
}
