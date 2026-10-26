/** Finite source owners for isolated native Worker entries. */
import { dirname, resolve } from "node:path";

export function workerPlanOwners(plan) {
  const owners = [plan.owner, ...(plan.additionalOwners ?? [])];
  const entry = resolve(dirname(plan.owner), plan.specifier);
  for (const owner of owners)
    if (resolve(dirname(owner), plan.specifier) !== entry)
      throw new Error(
        "Shared Worker aliases must reference the original entry.",
      );
  return owners;
}

export function defaultWorkers(root) {
  const backend = resolve(
    root,
    "../../packages/app-core/src/lib/secret-backends",
  );
  return [
    {
      owner: resolve(backend, "bitwarden-native-worker-client.ts"),
      specifier: "./bitwarden-native.worker.ts",
      name: "bitwarden-native.worker",
    },
    {
      owner: resolve(backend, "bitwarden-wasm-loader.ts"),
      specifier: "./bitwarden-secrets.worker.ts",
      name: "bitwarden-secrets.worker",
    },
    {
      owner: resolve(backend, "onepassword-sdk-loader.ts"),
      specifier: "./onepassword-sdk.worker.ts",
      name: "onepassword-sdk.worker",
    },
    {
      owner: resolve(
        root,
        "src/modules/networking.tailnet/browser/controller.ts",
      ),
      additionalOwners: [
        resolve(
          root,
          "src/modules/networking.tailnet/browser/identity-browser-node.ts",
        ),
      ],
      specifier: "./worker.ts",
      name: "tailscale-node",
    },
  ];
}
