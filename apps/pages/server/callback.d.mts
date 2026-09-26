export type RelayOutcome = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export function handleCallback(
  requestUrl: string,
  requestHost: string,
): RelayOutcome;
