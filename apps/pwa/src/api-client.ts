import { createApiClient as createApiClientImpl } from "@opensesame/api-client";

export const apiClientSeams = {
  createApiClient: createApiClientImpl,
};

export function createApiClient(
  ...args: Parameters<typeof createApiClientImpl>
): ReturnType<typeof createApiClientImpl> {
  return apiClientSeams.createApiClient(...args);
}
