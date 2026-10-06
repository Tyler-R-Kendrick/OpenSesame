import type { ComponentProps } from "react";
import {
  navigationContext,
  runSessionNavigation,
  sessionNavigationAllowed,
} from "../lib/decoy-navigation.js";
type AnchorProps = ComponentProps<"a">;
/** Removing href also prevents the browser's own menu opening an external site. */
export function SessionAnchor(props: AnchorProps) {
  const href = props.href;
  const allowed =
    !href || sessionNavigationAllowed(href, navigationContext(props.target));
  return (
    <a
      {...props}
      href={allowed ? href : undefined}
      aria-disabled={!allowed || props["aria-disabled"]}
      onClick={(event) => {
        if (
          href &&
          !runSessionNavigation(
            href,
            () => {},
            navigationContext(props.target, event),
          )
        ) {
          event.preventDefault();
          return;
        }
        props.onClick?.(event);
      }}
      onAuxClick={(event) => {
        if (
          href &&
          !runSessionNavigation(
            href,
            () => {},
            navigationContext(props.target, event),
          )
        ) {
          event.preventDefault();
          return;
        }
        props.onAuxClick?.(event);
      }}
    />
  );
}
