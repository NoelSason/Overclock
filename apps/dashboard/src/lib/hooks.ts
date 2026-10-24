"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RunStore, type Slice } from "./run-store";

/** One store per run id; disposed (stream closed, fetches aborted) when the id changes or on unmount. */
export function useRunStore(runId: string): RunStore | null {
  const [store, setStore] = useState<RunStore | null>(null);
  useEffect(() => {
    const s = new RunStore(runId);
    setStore(s);
    s.start();
    return () => s.dispose();
  }, [runId]);
  return store?.runId === runId ? store : null;
}

const noopSubscribe = () => () => undefined;

/** Re-render when any of the given slices changes; returns a number that changes with them. */
export function useSlices(store: RunStore | null, slices: readonly (Slice | "connection")[]): number {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (store ? store.version(slices) : -1),
    () => -1,
  );
}

/**
 * Trailing throttle for a changing value: re-renders at most once per `ms`, and always settles
 * on the latest value. Used by panels that are expensive to redraw (charts, the graph).
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      last.current = Date.now();
      timer.current = null;
      setShown(value);
    }, wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, shown, ms]);
  return shown;
}

/** Poll an async loader every `ms` while `enabled`; returns the latest result and error. */
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, ms: number, deps: readonly unknown[], enabled = true): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const d = await loadRef.current(ctrl.signal);
        if (ctrl.signal.aborted) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e);
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          if (enabled && ms > 0) timer = setTimeout(run, ms);
        }
      }
    };
    void run();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [...deps, ms, enabled, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
