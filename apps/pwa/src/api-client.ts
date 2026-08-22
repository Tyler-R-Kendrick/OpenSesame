import { createApiClient as createApiClientImpl } from "@opensesame/api-client";

type PwaApiClient = Pick<
  ReturnType<typeof createApiClientImpl>,
  "health" | "probeDaemon"
>;

interface PwaApiClientSeams {
  createApiClient: (
    ...args: Parameters<typeof createApiClientImpl>
  ) => PwaApiClient;
}

export const apiClientSeams: PwaApiClientSeams = {
  createApiClient: createApiClientImpl,
};

export function createApiClient(
  ...args: Parameters<typeof createApiClientImpl>
): PwaApiClient {
  return apiClientSeams.createApiClient(...args);
}
