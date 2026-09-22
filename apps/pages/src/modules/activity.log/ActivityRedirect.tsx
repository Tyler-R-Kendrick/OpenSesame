import { Navigate } from "react-router";

/** `/wallet/activity` was the log's first home; it now lives at `/activity`. */
export function WalletActivityRedirect() {
  return <Navigate to="/activity" replace />;
}
