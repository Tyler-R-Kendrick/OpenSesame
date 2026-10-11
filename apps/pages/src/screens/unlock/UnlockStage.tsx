import type { ReactNode, RefObject } from "react";
import { useImperativeHandle, useRef } from "react";
import {
  CipherWordmark,
  type CipherWordmarkHandle,
} from "../../components/CipherWordmark/index.js";
import { GateTools } from "../../components/GateTools.js";
import type { WordmarkHandle } from "../../components/Wordmark.js";
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
  const cipherHeroRef = useRef<CipherWordmarkHandle>(null);
  useImperativeHandle(
    wordmarkRef,
    () => ({
      replayCipher: () => {
        cipherHeroRef.current?.replay();
      },
    }),
    [],
  );
  return (
    <div className="unlock unlock--lock-v5" ref={paneRef}>
      <UnlockLockV5
        paneRef={paneRef}
        cardRef={cardRef}
        notesRef={notesRef}
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
        <CipherWordmark
          ref={cipherHeroRef}
          includeMark
          className="unlock__hero-wordmark"
          size={hero.size}
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
