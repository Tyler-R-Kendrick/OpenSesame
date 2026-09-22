import { Navigate } from "react-router";

/** `/agents` and `/sites` were the Access section's earlier homes. */
export function AccessRedirect() {
  return <Navigate to="/access" replace />;
}
