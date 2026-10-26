import { ConflictError } from "@opensesame/database";
import type { ErrorHandler } from "hono";
import type { Variables } from "../middleware/context.js";
import { OrganizationIssuerApprovalError } from "../services/org-issuer-approval.js";

export const organizationIssuerErrorHandler: ErrorHandler<{
  Variables: Variables;
}> = (error, c) => {
  if (error instanceof OrganizationIssuerApprovalError)
    return c.json(
      { error: "issuer_not_approved", message: error.message },
      403,
    );
  if (error instanceof ConflictError && error.message === "issuer_taken")
    return c.json({ error: "issuer_taken" }, 409);
  throw error;
};
