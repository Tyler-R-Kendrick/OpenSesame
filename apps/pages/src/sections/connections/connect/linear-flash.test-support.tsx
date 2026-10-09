import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useState } from "react";
import { useFlashNotice } from "../useFlashNotice.js";

/** Use the same notice owner as ConnectionsSection with real provider adapters. */
export function LinearFlashHarness({
  children,
}: {
  children: (report: (flash: Flash) => void) => ReactNode;
}) {
  const [flash, report] = useState<Flash | null>(null);
  useFlashNotice(flash, "linear-test", "Linear");
  return children(report);
}
