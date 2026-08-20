import { useEffect, useState } from "react";
import { isOnline, subscribeConnectivity } from "./connectivity.js";

function useOnlineDefault(): boolean {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => subscribeConnectivity(setOnline), []);
  return online;
}

export const useOnlineSeams = {
  useOnline: useOnlineDefault,
};

export function useOnline(): boolean {
  return useOnlineSeams.useOnline();
}
