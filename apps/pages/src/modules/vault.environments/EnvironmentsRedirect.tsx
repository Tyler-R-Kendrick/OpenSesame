import { ENVIRONMENTS_PATH } from "@opensesame/app-core/lib/vault/environments.js";
import { Navigate } from "react-router";

/**
 * `/environments` is the address the command bar types (`/environments`): a
 * phone has no key strip, and its Add button's slide has two zones, both
 * taken. It lands on the vault's own address, where the sheet is.
 */
export function EnvironmentsRedirect() {
  return <Navigate to={ENVIRONMENTS_PATH} replace />;
}
