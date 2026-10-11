/** "Use a different link" on `/claim` — loaded only while an arrival is held. */
export function ClaimDifferentLink({
  onChoose,
}: {
  onChoose: () => void;
}) {
  return (
    <button type="button" className="unlock__switch" onClick={onChoose}>
      Use a different link
    </button>
  );
}
