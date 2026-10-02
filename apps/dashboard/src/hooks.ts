import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./api";

export function useInterval(fn: () => void, ms: number | null): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Re-renders every `ms` so relative times ("2 min ago") stay true. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  set: (v: T) => void;
}

/** Loads on mount and when `deps` change; optionally refreshes every `pollMs`. A failed refresh keeps the last good data. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = [], pollMs: number | null = null): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(() => {
    loadRef.current().then(
      (d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!alive.current) return;
        setError(errorText(e));
        setLoading(false);
      },
    );
  }, []);
  useEffect(() => {
    setLoading(true);
    run();
  }, deps);
  useInterval(run, pollMs);
  return { data, error, loading, reload: run, set: setData };
}

export function usePersisted(key: string, initial: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (next: string) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* storage can be blocked: the value then lives only in memory */
    }
  };
  return [v, set];
}
