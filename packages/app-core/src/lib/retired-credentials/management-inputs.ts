/** Shared shapes for guarded owner-management entry points. */
import type { RetiredCredentialResponse } from "./records.js";
export type EnrollRetiredCredentialInput = {
  tomb: string;
  currentPassword: string;
  retiredPassword: string;
  response?: RetiredCredentialResponse;
  acknowledgePasswordVerifierRisk: boolean;
};
export type RemoveRetiredCredentialInput = {
  tomb: string;
  currentPassword: string;
  id: string;
};
export type ClearRetiredCredentialEventsInput = {
  tomb: string;
  currentPassword: string;
};
