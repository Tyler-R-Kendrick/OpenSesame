/** Shared closed JSON requests and safe collection results for provider-owned actions. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeApiOperationDefinition,
  executeNativeApiRequest,
} from "./native-api-operations.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
export type Resource = {
  providerId: string;
  id: string;
  label: string;
  read: (
    id: string,
    input: Record<string, string>,
    transport: NativeProviderTransport,
  ) => Promise<NativeApiReadResult>;
};
const resultSchema = z.object({
  label: z.string(),
  items: z.array(z.object({ id: z.string(), label: z.string() })).max(100),
});
export function jsonResource(
  label: string,
  definition: NativeApiOperationDefinition,
  project: (body: BoundaryValue) => BoundaryValue,
  body: BoundaryValue = {},
): Resource {
  return {
    providerId: definition.providerId,
    id: definition.operationId,
    label,
    async read(id, input, transport) {
      transport.assertCurrent();
      if (Object.keys(input).length)
        throw new Error(`${label} does not accept request fields`);
      const result = await executeNativeApiRequest(
        id,
        definition,
        body,
        project,
        transport,
      );
      transport.assertCurrent();
      return resultSchema.parse(result);
    },
  };
}
export const resourceText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }),
  );
export const resourceId = resourceText.refine((value) => value.length <= 256);
const itemSchema = z.object({ id: resourceId, label: resourceText });
/** Validate the entire bounded reply, including rows outside the displayed subset. */
export function projectResourceCollection(
  rows: { id: string; label: string }[],
  noun: string,
  mode: "first-page" | "returned",
): NativeApiReadResult {
  const items = z.array(itemSchema).parse(rows);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    (mode === "first-page" && items.length > 20)
  )
    throw new NativeApiError("response");
  const shown = items.slice(0, 20);
  return {
    label:
      mode === "first-page"
        ? `Showing ${shown.length} ${noun} from first page`
        : `Showing ${shown.length} of ${items.length} returned ${noun}`,
    items: shown,
  };
}
