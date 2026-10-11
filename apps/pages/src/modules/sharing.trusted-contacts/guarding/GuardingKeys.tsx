/**
 * The three keys on the Guarding panel's head, one for each thing a person
 * does as a guardian before they hold anything: accept an invitation, take
 * what an owner sent, answer a request. Each is a target the walkthrough
 * points at.
 */

import { IconKey } from "../../../components/IconKey.js";
import {
  IconDownload,
  IconPlus,
  IconSearch,
} from "../../../components/Icons.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";

export type HeadSheet = "accept" | "take" | "answer";

export function GuardingKeys({
  onOpen,
}: { onOpen: (sheet: HeadSheet) => void }) {
  const accept = useGuideTarget<HTMLButtonElement>("guarding.accept");
  const take = useGuideTarget<HTMLButtonElement>("guarding.take");
  const answer = useGuideTarget<HTMLButtonElement>("guarding.answer");
  return (
    <>
      <IconKey
        id="guarding-accept"
        keyRef={accept}
        label="Accept an invitation"
        small
        onClick={() => onOpen("accept")}
      >
        <IconPlus size={15} />
      </IconKey>
      <IconKey
        id="guarding-take"
        keyRef={take}
        label="Take what an owner sent"
        small
        onClick={() => onOpen("take")}
      >
        <IconDownload size={15} />
      </IconKey>
      <IconKey
        id="guarding-answer"
        keyRef={answer}
        label="Answer a request"
        small
        onClick={() => onOpen("answer")}
      >
        <IconSearch size={15} />
      </IconKey>
    </>
  );
}
