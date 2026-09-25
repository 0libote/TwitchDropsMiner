/**
 * Miner actions (pause, resume, refresh, restart, …).
 *
 * Destructive actions still confirm through the browser dialog: the miner
 * keeps running while this page is closed, and a stray restart is worse than
 * an ugly prompt.
 */

import {useCallback, useState} from "react";
import {request} from "./api";
import {useStore} from "./store";

const CONFIRMED = new Set(["logout", "shutdown", "restart"]);

export interface ActionRunner {
  run: (name: string, label: string) => Promise<void>;
  pending: string | null;
}

export function useAction(): ActionRunner {
  const {toast} = useStore();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (name: string, label: string) => {
      if (CONFIRMED.has(name) && !confirm(`${label}?`)) return;
      setPending(name);
      try {
        await request(`/api/actions/${name}`, {method: "POST"});
        toast(`${label} requested`);
      } catch (error) {
        toast(error instanceof Error && error.message ? error.message : "Request failed", true);
      } finally {
        setPending(null);
      }
    },
    [toast],
  );

  return {run, pending};
}
