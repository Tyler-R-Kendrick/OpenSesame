import type { CandidateCustody } from "./secrets.js";
import type { ProxyProof } from "./types.js";

export type TransportKind = "cdp" | "extension" | "proxy";

export interface ResetTransport {
  readonly kind: TransportKind;
  readonly available: boolean;
  readonly proxyProof?: ProxyProof;
  fillReal(password: string): Promise<void>;
  fillSynthetic(synthetic: string, proof: ProxyProof): Promise<void>;
}

const PREFERENCE: readonly TransportKind[] = ["cdp", "extension", "proxy"];

export function selectTransport(
  transports: readonly ResetTransport[],
): ResetTransport {
  for (const kind of PREFERENCE) {
    const selected = transports.find((transport) => transport.kind === kind && transport.available);
    if (selected) {
      if (kind === "proxy" && !selected.proxyProof)
        throw new Error("The proxy has no exact-form substitution proof");
      return selected;
    }
  }
  throw new Error("No approved password-reset transport is available");
}

export async function fillBeforeSubmit(
  selected: ResetTransport,
  custody: CandidateCustody,
): Promise<void> {
  if (selected.kind === "proxy") {
    const proof = selected.proxyProof;
    if (!proof) throw new Error("The selected proxy has no exact-form proof");
    await custody.withSynthetic(proof, (synthetic) => selected.fillSynthetic(synthetic, proof));
    return;
  }
  await custody.withPassword((password) => selected.fillReal(password));
}
