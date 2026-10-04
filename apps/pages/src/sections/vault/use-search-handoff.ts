import { type Dispatch, type SetStateAction, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * Opens the list's search prompt when a navigation asks for it
 * (`navigate(to, { state: { search: true } })`) — the phone's section tree
 * has a search key but no list of its own to search, so it hands the prompt
 * to the list it jumps to. The request is spent on arrival, so a reload or the
 * Back key does not open the prompt a second time.
 */
export function useSearchHandoff(
  setQuery: Dispatch<SetStateAction<string | null>>,
): void {
  const location = useLocation();
  const navigate = useNavigate();
  const asked =
    (location.state as { search?: boolean } | null)?.search === true;
  useEffect(() => {
    if (!asked) return;
    setQuery((current) => current ?? "");
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
  }, [asked, setQuery, location.pathname, location.search, navigate]);
}
