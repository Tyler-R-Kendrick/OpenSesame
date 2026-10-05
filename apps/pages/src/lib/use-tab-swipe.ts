import { useEffect } from "react";
import { installTabSwipe } from "./tab-swipe.js";

/** Swiping a screen sideways turns its tabs, wherever the app is drawn. */
export function useTabSwipe(): void {
  useEffect(() => installTabSwipe(), []);
}
