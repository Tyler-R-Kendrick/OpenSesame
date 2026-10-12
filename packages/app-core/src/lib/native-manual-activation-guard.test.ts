/** A provider check may succeed before its initiating capability is disposed during sealing. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import {
  configureNativeApiConnector,
  verifyNativeApiConnector,
} from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import { readNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeConnectorView } from "./native-connector-view.js";
import {
  configureNativeGithubPersonal,
  verifyNativeGithubPersonal,
} from "./native-github-personal.js";
import {
  configureNativeLocalInstance,
  verifyNativeLocalInstance,
} from "./native-local-instance.js";

installNativeApiTests();
type ManualFlow = {
  id: string;
  body: BoundaryValue;
  configure: (
    transport: NativeProviderTransport,
  ) => Promise<NativeConnectorView>;
  verify: (
    id: string,
    transport: NativeProviderTransport,
  ) => Promise<NativeConnectorView>;
};
const flows: ManualFlow[] = [
  {
    id: "github",
    body: { id: 12345, login: "octocat", type: "User" },
    configure: (transport) =>
      configureNativeGithubPersonal(nativeApiDraft("github"), transport),
    verify: verifyNativeGithubPersonal,
  },
  {
    id: "generic-api",
    body: { data: [] },
    configure: (transport) =>
      configureNativeApiConnector(nativeApiDraft("openai"), transport),
    verify: verifyNativeApiConnector,
  },
  {
    id: "vault-token",
    body: {
      data: {
        entity_id: "user-1",
        display_name: "Engineer",
        policies: ["default"],
        ttl: 3600,
        renewable: true,
      },
    },
    configure: (transport) =>
      configureNativeLocalInstance(
        {
          providerId: "vault",
          displayName: "Vault",
          icon: "",
          endpoint: "https://vault.example.org",
          namespace: "",
          apiKey: "hvs.private-manual-token",
        },
        transport,
      ),
    verify: verifyNativeLocalInstance,
  },
];
function stageDisposal(transport: NativeProviderTransport): void {
  let current = true;
  transport.assertCurrent = () => {
    if (!current) throw new Error("Manual provider runtime disposed");
  };
  const write = kvSeams.kvSetDurable;
  vi.mocked(kvSeams.kvSetDurable).mockImplementationOnce(
    async (key, value, beforeCommit) => {
      // Storage encryption/staging awaits; disposal occurs before the physical close.
      await Promise.resolve();
      current = false;
      expect(beforeCommit).toBeTypeOf("function");
      beforeCommit?.();
      await write(key, value, beforeCommit);
    },
  );
}
it.each(flows)(
  "does not activate a new $id credential after disposal during its durable write",
  async (flow) => {
    const answers = nativeAnswers({ body: flow.body });
    stageDisposal(answers.transport);
    await expect(flow.configure(answers.transport)).rejects.toThrow(
      "runtime disposed",
    );
    expect(answers.fetch).toHaveBeenCalledTimes(1);
    expect(readDeviceRows()).toEqual([]);
  },
);
it.each(flows)(
  "preserves the previous $id proof if reverification is disposed during its durable write",
  async (flow) => {
    const answers = nativeAnswers({ body: flow.body }, { body: flow.body });
    const saved = await flow.configure(answers.transport);
    stageDisposal(answers.transport);
    await expect(
      flow.verify(saved.connectionId, answers.transport),
    ).rejects.toThrow("runtime disposed");
    expect(answers.fetch).toHaveBeenCalledTimes(2);
    expect(readNativeConnector(saved.connectionId)).toEqual(saved);
  },
);
