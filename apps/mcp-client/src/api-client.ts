import {
  createApiClient as createApiClientImpl,
  normalizeHttpBaseUrl,
} from "@opensesame/api-client";

export { normalizeHttpBaseUrl };

export const apiClientSeams = {
  createApiClient: createApiClientImpl,
};

export function createApiClient(
  ...args: Parameters<typeof createApiClientImpl>
): ReturnType<typeof createApiClientImpl> {
  return apiClientSeams.createApiClient(...args);
}
