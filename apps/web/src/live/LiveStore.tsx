import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { coalesce } from "../../../ui/src/coalesce.js";
import type { WebBridge } from "../bridge/webBridge.js";
import { staleQueries } from "./refreshMap.js";

type Listener = () => void;
interface Store {
  bridge: WebBridge;
  watch(name: string, listener: Listener): () => void;
}

const StoreContext = createContext<Store | undefined>(undefined);

export function LiveStoreProvider({ bridge, children }: { bridge: WebBridge; children: ReactNode }) {
  const listeners = useRef(new Map<string, Set<Listener>>());
  useEffect(() => {
    // One subscription per tab; queries refetch only while a mounted view watches them.
    return bridge.subscribe(0, {}, (event) => {
      for (const name of staleQueries(event.type)) listeners.current.get(name)?.forEach((listener) => listener());
    });
  }, [bridge]);
  const store = useMemo<Store>(
    () => ({
      bridge,
      watch(name, listener) {
        const set = listeners.current.get(name) ?? new Set();
        set.add(listener);
        listeners.current.set(name, set);
        return () => set.delete(listener);
      },
    }),
    [bridge],
  );
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("LiveStoreProvider is missing");
  return store;
}

export function useBridge(): WebBridge {
  return useStore().bridge;
}

export interface Live<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh(): void;
}

/** Runs a query and keeps it fresh from events. `args` is compared by its JSON form. */
export function useLiveQuery<T>(name: string, args: unknown = {}, enabled = true): Live<T> {
  const { bridge, watch } = useStore(),
    key = JSON.stringify(args),
    [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
      data: undefined,
      error: undefined,
      loading: enabled,
    }),
    refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const runner = coalesce(async () => {
      try {
        const data = await bridge.query<T>(name, JSON.parse(key));
        if (alive) setState({ data, error: undefined, loading: false });
      } catch (error) {
        if (alive) setState((current) => ({ ...current, error, loading: false }));
      }
    }, 60);
    refreshRef.current = runner.schedule;
    runner.schedule();
    const unwatch = watch(name, runner.schedule);
    return () => {
      alive = false;
      unwatch();
      runner.stop();
    };
  }, [bridge, watch, name, key, enabled]);
  const refresh = useCallback(() => refreshRef.current(), []);
  // Until the first answer arrives the query is loading, even if it was just enabled.
  return { ...state, loading: enabled && state.data === undefined && state.error === undefined, refresh };
}
