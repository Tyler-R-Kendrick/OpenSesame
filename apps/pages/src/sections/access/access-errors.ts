import { AccessError } from "../../lib/access.js";
import { HostSessionError } from "../../lib/identity.js";
import { errorText } from "../connections/shared.js";

export function accessErrorText<Thrown>(error: Thrown): string {
  if (error instanceof HostSessionError) return errorText(error);
  if (error instanceof AccessError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
