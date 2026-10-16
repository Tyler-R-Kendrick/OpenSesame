import { downloadText } from "@opensesame/app-core/lib/sops/download.js";
import { tailscaleRegistrationArtifact } from "@opensesame/app-core/lib/tailscale/artifacts.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { runTailscaleAction } from "./tailscale-actions.js";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
import { type TailscaleState, useTailscaleState } from "./useTailscaleState.js";
function prepareRegistration(model: TailscaleState): string | null {
  model.setFailure("");
  try {
    return tailscaleRegistrationArtifact(
      model.saved ?? { ...model.draft, redirectUri: deps.redirectUri() },
    );
  } catch {
    model.setFailure(
      "Check the app name, tailnet, URLs and custom: node attributes before preparing registration.",
    );
    return null;
  }
}
export function useTailscaleApp(
  connectionId: string | undefined,
  onChanged: () => void,
  onFlash: (flash: Flash) => void,
) {
  const model = useTailscaleState(connectionId);
  const run = (action: Parameters<typeof runTailscaleAction>[1]) =>
    runTailscaleAction(model, action, onChanged, onFlash);
  return {
    ...model,
    changed(field: "apiBase" | "tailnet" | "name", value: string) {
      model.clear();
      model.setDraft((current) => ({ ...current, [field]: value }));
      model.setFailure("");
      model.setResult("");
    },
    register: () => run("register"),
    provision: () => run("provision"),
    forget: () => run("forget"),
    importApp: () => run("import"),
    handoff: () => run("handoff"),
    cancel: model.clear,
    artifact: () => prepareRegistration(model),
    download() {
      const request = prepareRegistration(model);
      if (!request) return;
      try {
        downloadText("tailscale-registration.json", request, "plaintext");
      } catch {
        model.setFailure(
          "Could not download the Tailscale registration request.",
        );
      }
    },
  };
}
export type TailscaleEditor = ReturnType<typeof useTailscaleApp>;
