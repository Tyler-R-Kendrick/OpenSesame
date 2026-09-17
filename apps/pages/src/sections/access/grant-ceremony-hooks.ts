import { useCallback, useEffect, useRef, useState } from "react";

/** Ticks so expiry countdowns move without a refetch. */
export function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

export function countdown(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "expired";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  if (seconds < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }, []);

  return { copy, copied } as const;
}
