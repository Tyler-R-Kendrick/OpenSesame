import { acmeKeyFlows } from "./native-acme.js";
import { type FakeAcmeOptions, fakeAcme } from "./native-acme.test-support.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";

export const draft = (extra: Record<string, string> = {}) => ({
  providerId: "letsencrypt",
  displayName: "Let's Encrypt staging",
  parameters: { environment: "staging", accept_terms: "yes", ...extra },
  credentials: {},
});

export async function connected(options: FakeAcmeOptions = {}) {
  const ca = fakeAcme(options);
  const saved = await acmeKeyFlows.configure(draft(), ca.transport);
  const jwk = JSON.parse(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.credentials
      .account_key ?? "{}",
  );
  return { ca, saved, jwk, id: saved.connectionId };
}
