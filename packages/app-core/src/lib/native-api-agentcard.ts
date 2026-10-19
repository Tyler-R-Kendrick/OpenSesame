/** Platform organization introspection; member credentials and payment data are not accepted. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import { resourceId } from "./native-api-resource.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";
zodJitless();
const organization = z.object({
  object: z.literal("api_v2"),
  organization_id: resourceId.refine((value) => value.trim().length > 0),
  test_mode: z.boolean(),
  mode: z.enum(["sandbox", "production"]).optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
export function parseNativeAgentcardOrganization(body: BoundaryValue) {
  const result = organization.safeParse(body);
  if (
    !result.success ||
    (result.data.mode !== undefined &&
      result.data.mode !== (result.data.test_mode ? "sandbox" : "production"))
  )
    throw new NativeApiError("response");
  return result.data;
}
export function projectNativeAgentcardOrganization(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeAgentcardOrganization(body);
  const mode = value.test_mode ? "test mode" : "production";
  return {
    label: `Agentcard platform organization (${mode})`,
    items: [
      {
        id: value.organization_id,
        label: `${value.organization_id} — ${mode}`,
      },
    ],
  };
}
