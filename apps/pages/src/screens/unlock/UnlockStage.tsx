import type { ReactNode, RefObject } from "react";
import { GateTools } from "../../components/GateTools.js";
import { Wordmark, type WordmarkHandle } from "../../components/Wordmark.js";
import { PendingLinkBanner } from "./PendingLinkBanner.js";
import { ReleaseNotes } from "./ReleaseNotes.js";
import { UnlockLockV5 } from "./UnlockLockV5.js";
import { useUnlockHeroLayout } from "./use-unlock-hero-layout.js";

export type UnlockStageProps = {
  paneRef: RefObject<HTMLDivElement | null>;
  cardRef: RefObject<HTMLDivElement | null>;
  notesRef: RefObject<HTMLElement | null>;
  wordmarkRef: RefObject<WordmarkHandle | null>;
  ceremonyToken: number;
  vaultUnlocked: boolean;
  children: ReactNode;
};

/** Lock-v5 chrome: dial/doors, hero wordmark, card shell, release notes. */
export function UnlockStage({
  paneRef,
  cardRef,
  notesRef,
  wordmarkRef,
  ceremonyToken,
  vaultUnlocked,
  children,
}: UnlockStageProps) {
  const hero = useUnlockHeroLayout(paneRef, cardRef, notesRef);
  return (
    <div className="unlock unlock--lock-v5" ref={paneRef}>
      <UnlockLockV5
        paneRef={paneRef}
        cardRef={cardRef}
        notesRef={notesRef}
        wordmarkRef={wordmarkRef}
        ceremonyToken={ceremonyToken}
        vaultUnlocked={vaultUnlocked}
      />
      <div
        className="unlock__hero"
        aria-hidden="true"
        style={{
          left: hero.left,
          top: hero.top,
          fontSize: `${hero.size}px`,
        }}
      >
        <Wordmark
          ref={wordmarkRef}
          className="unlock__hero-wordmark"
          size={hero.size}
          includeMark
        />
      </div>
      <div className="unlock__card" ref={cardRef}>
        <PendingLinkBanner />
        <div className="unlock__brand">
          {/* Space kept for the in-card wordmark the hero replaced (lock-v5). */}
          <span className="unlock__wordmark unlock__wordmark--reserve" />
          <div className="unlock__brand-tools">
            <GateTools />
          </div>
        </div>
        {children}
      </div>
      <ReleaseNotes ref={notesRef} />
    </div>
  );
}
