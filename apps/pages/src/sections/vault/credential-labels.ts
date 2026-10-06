import type { ApiKeyMethod, LoginMethod } from "@opensesame/vault-core";
import { headerName } from "@opensesame/vault-core";

/**
 * What an API key's two values are called: the header it travels in, and its
 * value (`X-Api-Key value`). An account may hold several API keys, so the
 * header's name is repeated in the value's label, and a second key under the
 * same header is numbered so no two rows read alike.
 */
export type ApiKeyLabels = { header: string; value: string };

export function apiKeyLabels(
  methods: readonly LoginMethod[],
  method: ApiKeyMethod,
): ApiKeyLabels {
  const keys = methods.filter(
    (entry): entry is ApiKeyMethod => entry.type === "api-key",
  );
  const name = headerName(method.header);
  const order = keys.indexOf(method) + 1;
  const sameHeader = keys.filter(
    (entry) => headerName(entry.header).toLowerCase() === name.toLowerCase(),
  );
  return {
    header: keys.length > 1 ? `API header ${order}` : "API header",
    value:
      sameHeader.length > 1
        ? `${name} value ${sameHeader.indexOf(method) + 1}`
        : `${name} value`,
  };
}
