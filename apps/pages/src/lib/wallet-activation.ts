/**
 * Activation flags cannot mint issuer, prepaid, Tempo, OWS, or mainnet.
 * productionEnabled is false unless evidenceStatus is target_deployment_verified
 * — which this assignment never records.
 */

export type WalletEvidenceStatus =
  | "specified"
  | "source_inspected"
  | "fixture_verified"
  | "local_execution_verified"
  | "target_deployment_verified"
  | "blocked";

export function adapterProductionEnabled(input: {
  readonly evidenceStatus: WalletEvidenceStatus;
  readonly configFlag?: boolean;
  readonly uiToggle?: boolean;
}): boolean {
  if (input.evidenceStatus !== "target_deployment_verified") {
    return false;
  }
  void input.configFlag;
  void input.uiToggle;
  return false;
}

export function temporaryCardIssuanceAvailable(input: {
  readonly issuerAdapterReady?: boolean;
  readonly configUnlock?: boolean;
}): false {
  void input.issuerAdapterReady;
  void input.configUnlock;
  return false;
}
