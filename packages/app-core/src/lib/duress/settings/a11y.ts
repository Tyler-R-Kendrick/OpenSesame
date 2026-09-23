/**
 * Accessibility helpers for duress settings (SETTINGS-E).
 */

export type MotionPreference = "full" | "reduced";

export function resolveMotionPreference(
  media: { matches: boolean } | null | undefined,
): MotionPreference {
  return media?.matches ? "reduced" : "full";
}

export type FocusOrderItem = Readonly<{
  id: string;
  role: "tab" | "checkbox" | "button" | "textbox" | "radio";
  label: string;
}>;

/** Canonical keyboard focus order for the enrollment panel. */
export function enrollmentFocusOrder(): FocusOrderItem[] {
  return [
    { id: "duress-mode-preset", role: "tab", label: "Presets" },
    { id: "duress-mode-advanced", role: "tab", label: "Advanced" },
    { id: "duress-consent-owner", role: "checkbox", label: "Owner consent" },
    {
      id: "duress-consent-destructive",
      role: "checkbox",
      label: "Destructive acknowledgement",
    },
    { id: "duress-rehearsal-run", role: "button", label: "Run rehearsal" },
    { id: "duress-code-input", role: "textbox", label: "New trigger code" },
    { id: "duress-arm", role: "button", label: "Arm after rehearsal" },
    { id: "duress-disarm", role: "button", label: "Disarm" },
  ];
}

export type MobileLayoutHints = Readonly<{
  stackVertically: boolean;
  compactActions: boolean;
}>;

export function mobileLayoutHints(viewportWidth: number): MobileLayoutHints {
  return {
    stackVertically: viewportWidth < 720,
    compactActions: viewportWidth < 480,
  } satisfies MobileLayoutHints;
}
