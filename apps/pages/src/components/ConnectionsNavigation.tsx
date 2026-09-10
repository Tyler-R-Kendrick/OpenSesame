import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Connection, Provider } from "../lib/connections.js";

type Snapshot = {
  providers: Provider[] | null;
  connections: Connection[] | null;
};
const EMPTY: Snapshot = { providers: null, connections: null };
const Data = createContext<Snapshot>(EMPTY);
const Publish = createContext<(snapshot: Snapshot) => void>(() => {});

/** The page owns loading; the rail only projects the same snapshot. */
export function ConnectionsNavigation({ children }: { children: ReactNode }) {
  const [snapshot, publish] = useState(EMPTY);
  return (
    <Publish.Provider value={publish}>
      <Data.Provider value={snapshot}>{children}</Data.Provider>
    </Publish.Provider>
  );
}

export function useConnectionsNavigation() {
  return useContext(Data);
}

export function usePublishConnections(
  providers: Provider[] | null,
  connections: Connection[] | null,
) {
  const publish = useContext(Publish);
  useEffect(() => {
    publish({ providers, connections });
  }, [providers, connections, publish]);
  useEffect(() => () => publish(EMPTY), [publish]);
}
