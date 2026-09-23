/**
 * Settings › Security shell — wires DuressProfilesPanel into navigation.
 * Feature mode stays off by default (INV-01); panel is present for local_only|optional_peer.
 */

import { resolveDuressMode } from "@opensesame/app-core/lib/duress/feature/mode.js";
import type { CompilerCatalog, PolicyDocument } from "@opensesame/contracts";
import { type ReactNode, createElement } from "react";
import {
  DuressProfilesPanel,
  type DuressProfilesPanelProps,
} from "./security/DuressProfilesPanel.js";

export type SettingsSecurityProps = Readonly<{
  document: PolicyDocument | null;
  catalog: CompilerCatalog;
  onArm: DuressProfilesPanelProps["onArm"];
  reducedMotion?: boolean;
  /** Override for tests — production reads prefs/env via resolveDuressMode. */
  mode?: ReturnType<typeof resolveDuressMode>;
}>;

export function SettingsSecurity(props: SettingsSecurityProps): ReactNode {
  const mode = props.mode ?? resolveDuressMode({});
  if (mode === "off") {
    return null;
  }
  return createElement(DuressProfilesPanel, {
    document: props.document,
    catalog: props.catalog,
    onArm: props.onArm,
    reducedMotion: props.reducedMotion,
  });
}

export { DuressProfilesPanel } from "./security/DuressProfilesPanel.js";
