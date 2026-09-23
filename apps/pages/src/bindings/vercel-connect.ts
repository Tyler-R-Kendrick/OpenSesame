import {
  subscribeVercelConnectAuth,
  vercelConnectConfigured,
} from "@opensesame/app-core/lib/vercel-connect.js";
import { useSyncExternalStore } from "react";

export function useVercelConnectConfigured(): boolean {
  return useSyncExternalStore(
    subscribeVercelConnectAuth,
    vercelConnectConfigured,
    vercelConnectConfigured,
  );
}
