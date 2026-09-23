import {
  isOnline,
  subscribeConnectivity,
} from "@opensesame/app-core/lib/connectivity.js";
import { useEffect, useState } from "react";

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
