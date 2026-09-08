import { useEffect, useState } from "react";
import { loadSettings, settingsSeams } from "../lib/settings.js";
import { FieldShell } from "./FieldShell.js";
import { IconTerminal } from "./Icons.js";

export function ManualUrlField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);

  // Offering the clipboard is only worth it when it holds something that
  // parses as a URL — otherwise the chip is a dead end.
  useEffect(() => {
    if (!navigator.clipboard?.readText) return;
    let cancelled = false;
    void navigator.clipboard.readText().then(
      (text) => {
        const candidate = text.trim();
        if (cancelled || !candidate) return;
        try {
          const url = new URL(candidate);
          if (url.protocol === "http:" || url.protocol === "https:") {
            setClipboardUrl(url.origin);
          }
        } catch {
          // Not a URL — no chip.
        }
      },
      () => {
        // Permission denied or unavailable — no chip.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const savedDaemon = loadSettings().daemonApi.trim();
  const fills = [
    savedDaemon && savedDaemon !== value ? savedDaemon : null,
    settingsSeams.pageIsLoopback() && value !== settingsSeams.shippedDaemonApi
      ? settingsSeams.shippedDaemonApi
      : null,
    clipboardUrl && clipboardUrl !== value ? clipboardUrl : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <FieldShell
      id="daemon-url"
      label="Daemon (Tailscale Serve URL)"
      type="url"
      mono
      lead={<IconTerminal size={17} />}
      placeholder="https://your-machine.tailnet.ts.net"
      value={value}
      onValueChange={onChange}
      fills={fills.map((entry) => ({
        label: entry,
        onPick: () => onChange(entry),
      }))}
    />
  );
}
