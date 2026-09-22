import { useSyncExternalStore } from "react";
import {
  subscribeVercelConnectAuth,
  vercelConnectConfigured,
} from "../lib/vercel-connect.js";

export function useVercelConnectConfigured(): boolean {
  return useSyncExternalStore(
    subscribeVercelConnectAuth,
    vercelConnectConfigured,
    vercelConnectConfigured,
  );
}
