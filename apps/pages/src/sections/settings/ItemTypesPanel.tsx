/**
 * The Vaults category of Settings: the vault switcher, travel (ADR 0140),
 * then the item types those vaults can hold (`item-types/`, ADR 0087 §7 and
 * ADR 0134).
 */
import type { ComponentType } from "react";
import { ItemTypesPanel } from "./item-types/ItemTypesPanel.js";
import { TravelPanel } from "./travel/TravelPanel.js";

export { ItemTypesPanel };

/** The vaults category: the vault switcher and the item types it can shape. */
export function VaultsAndTypes({
  VaultsPanel,
}: { VaultsPanel: ComponentType }) {
  return (
    <>
      <VaultsPanel />
      <TravelPanel />
      <ItemTypesPanel />
    </>
  );
}
