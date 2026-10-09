import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useLinearCallback } from "./useLinearCallback.js";
import { useNativeCallback } from "./useNativeCallback.js";

export function useProviderCallbacks(
  search: string,
  reload: () => Promise<void>,
  onFlash: (flash: Flash) => void,
): void {
  const query = new URLSearchParams(search);
  const linear = query.has("linear_state");
  const native = query.has("native_state");
  const ambiguous = linear && native;
  useLinearCallback(linear && !ambiguous ? search : "", reload, onFlash);
  useNativeCallback(native && !ambiguous ? search : "", reload, onFlash);
  const navigate = useNavigate();
  const rejected = useRef<string | null>(null);
  useEffect(() => {
    if (!ambiguous || rejected.current === search) return;
    rejected.current = search;
    navigate("/connections", { replace: true });
    onFlash({
      tone: "err",
      text: "This callback contains conflicting provider authorization states. Start authorization again.",
    });
  }, [ambiguous, search, navigate, onFlash]);
}
