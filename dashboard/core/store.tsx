/**
 * Miner state store.
 *
 * One Server-Sent Events subscription feeds the whole dashboard; every route
 * reads the same snapshot. Settings live in a local draft that is only
 * synced from the server while it is clean, so live updates can never
 * discard in-progress edits.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {DashboardState, MinerSettings} from "../../web/api-types";
import {request, resetCsrfToken} from "./api";

export interface ToastMessage {
  id: number;
  text: string;
  isError: boolean;
}

export interface StoreValue {
  state: DashboardState;
  connected: boolean;
  /** Local settings draft; never overwritten while `dirty`. */
  settings: MinerSettings;
  dirty: boolean;
  /** Changes whenever the signed-in account changes; used to drop cached data. */
  accountKey: string;
  update: (patch: Partial<MinerSettings>) => void;
  save: (values?: MinerSettings, message?: string) => Promise<boolean>;
  discard: () => void;
  toast: (text: string, isError?: boolean) => void;
  toastMessage: ToastMessage | null;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside <MinerProvider>");
  return value;
}

export function cloneSettings(values: MinerSettings): MinerSettings {
  return {
    priority: [...values.priority],
    exclude: [...values.exclude],
    priorityMode: values.priorityMode,
    connectionQuality: values.connectionQuality,
    trayNotifications: values.trayNotifications,
    enableBadgesEmotes: values.enableBadgesEmotes,
    availableDropsCheck: values.availableDropsCheck,
    proxy: values.proxy,
    webhookUrl: values.webhookUrl || "",
  };
}

export function MinerProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(false);
  const [settings, setSettings] = useState<MinerSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toastMessage, setToastMessage] = useState<ToastMessage | null>(null);

  const dirtyRef = useRef(false);
  const stateRef = useRef<DashboardState | null>(null);
  const settingsRef = useRef<string>("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const toast = useCallback((text: string, isError = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastId.current += 1;
    setToastMessage({id: toastId.current, text, isError});
    toastTimer.current = setTimeout(() => setToastMessage(null), 2600);
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onmessage = (event: MessageEvent<string>) => {
      let next: DashboardState;
      try {
        next = JSON.parse(event.data) as DashboardState;
      } catch {
        return; // Ignore a malformed frame; the next snapshot recovers.
      }
      const previous = stateRef.current;
      if (
        previous &&
        (String(previous.login?.userId ?? "") !== String(next.login?.userId ?? "") ||
          Boolean(previous.canLogout) !== Boolean(next.canLogout))
      ) {
        resetCsrfToken(); // The server rotates its token alongside the session.
      }
      stateRef.current = next;
      if (!dirtyRef.current) {
        const serialized = JSON.stringify(next.settings);
        if (serialized !== settingsRef.current) {
          settingsRef.current = serialized;
          setSettings(cloneSettings(next.settings));
        }
      }
      setState(next);
      setConnected(true);
    };
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);

  const update = useCallback((patch: Partial<MinerSettings>) => {
    setSettings((current) => (current ? {...current, ...patch} : current));
    setDirty(true);
  }, []);

  const discard = useCallback(() => {
    const snapshot = stateRef.current;
    if (snapshot) {
      settingsRef.current = JSON.stringify(snapshot.settings);
      setSettings(cloneSettings(snapshot.settings));
    }
    setDirty(false);
  }, []);

  const save = useCallback(
    async (values?: MinerSettings, message = "Settings saved") => {
      const source = values ?? settings;
      if (!source) return false;
      try {
        const snapshot = cloneSettings(source);
        await request("/api/settings", {method: "PUT", body: JSON.stringify(snapshot)});
        settingsRef.current = JSON.stringify(snapshot);
        setSettings(snapshot);
        setDirty(false);
        const current = stateRef.current;
        if (current) {
          stateRef.current = {...current, settings: cloneSettings(snapshot)};
          setState(stateRef.current);
        }
        toast(message);
        return true;
      } catch (error) {
        toast(error instanceof Error && error.message ? error.message : "Unable to save settings", true);
        return false;
      }
    },
    [settings, toast],
  );

  const accountKey = state ? `${state.login?.userId ?? ""}|${Boolean(state.canLogout)}` : "";

  const value = useMemo<StoreValue | null>(() => {
    if (!state || !settings) return null;
    return {
      state,
      connected,
      settings,
      dirty,
      accountKey,
      update,
      save,
      discard,
      toast,
      toastMessage,
    };
  }, [state, connected, settings, dirty, accountKey, update, save, discard, toast, toastMessage]);

  if (!value) return <LoadingScreen />;
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** No snapshot yet: the dashboard is connecting (or cannot be reached). */
function LoadingScreen() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // EventSource retries forever; surface the state after the first pause.
    const timer = setTimeout(() => setFailed(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div id="loading" className="loading" role="status">
      {failed ? "Unable to reach the miner. Retrying automatically…" : "Connecting to the miner…"}
    </div>
  );
}
