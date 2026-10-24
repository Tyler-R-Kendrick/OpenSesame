/** Filtered, bounded user inventory; no personal, funding or card fields survive. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
function opaqueIdentifier(value: string) {
  return (
    value.trim().length > 0 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}
const user = z.object({
  token: z.string().min(1).max(36).refine(opaqueIdentifier),
  active: z.boolean().optional(),
});
const page = z.object({
  count: z.number().int().min(0).max(10).optional(),
  data: z.array(user).max(10).optional(),
  start_index: z.literal(0).optional(),
  end_index: z.number().int().min(-1).max(9).optional(),
  is_more: z.boolean().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
  error_message: z.never().optional(),
  error_code: z.never().optional(),
});
function emptyPage(value: z.infer<typeof page>) {
  return (
    value.data?.length === 0 &&
    (value.count === undefined || value.count === 0) &&
    (value.end_index === undefined || value.end_index <= 0) &&
    value.is_more !== true
  );
}
export function parseNativeMarqetaUsers(body: BoundaryValue) {
  // The official response schema makes every pagination field conditional on resources.
  if (isJsonObject(body) && Object.keys(body).length === 0)
    return { data: [], is_more: false };
  const result = page.safeParse(body);
  if (!result.success) throw new NativeApiError("response");
  const value = result.data;
  if (emptyPage(value)) return { data: [], is_more: false };
  if (
    !value.data?.length ||
    value.count !== value.data.length ||
    value.start_index !== 0 ||
    value.end_index !== value.data.length - 1 ||
    value.is_more === undefined ||
    new Set(value.data.map((item) => item.token)).size !== value.data.length
  )
    throw new NativeApiError("response");
  return { data: value.data, is_more: value.is_more };
}
export function projectNativeMarqetaUsers(
  body: BoundaryValue,
): NativeApiReadResult {
  const value = parseNativeMarqetaUsers(body);
  return {
    label: `Showing ${value.data.length} users from first page${value.is_more ? "; more available" : ""}`,
    items: value.data.map((item) => ({
      id: item.token,
      label: `${item.token} — ${item.active === undefined ? "status not returned" : item.active ? "active" : "inactive"}`,
    })),
  };
}
