import { useEffect, useState } from "react";

const WALLET_RECORDS_CHANGED = "opensesame:wallet-records-changed";

/** Keep the rail and current listing in step after a local ledger mutation. */
export function walletRecordsChanged(): void {
  window.dispatchEvent(new Event(WALLET_RECORDS_CHANGED));
}

export function useWalletRecords(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((tick) => tick + 1);
    window.addEventListener(WALLET_RECORDS_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(WALLET_RECORDS_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
}

export function walletRecordId(hash: string): string | null {
  try {
    return hash ? decodeURIComponent(hash.slice(1)) : null;
  } catch {
    return null;
  }
}

export function walletRecordPath(path: string, id: string): string {
  return `${path}#${encodeURIComponent(id)}`;
}
