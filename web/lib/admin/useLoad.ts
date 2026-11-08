"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminApi } from "./api";
import { useSession } from "./session";

/** Carga datos con la API activa. `deps` re-dispara la carga. */
export function useLoad<T>(fn: (api: AdminApi) => Promise<T>, deps: unknown[]) {
  const { api } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const reqId = useRef(0);
  const depsKey = JSON.stringify(deps);

  const run = useCallback(
    async (silent = false) => {
      if (!api) return;
      const my = ++reqId.current;
      if (!silent) setLoading(true);
      try {
        const v = await fnRef.current(api);
        if (my === reqId.current) {
          setData(v);
          setError(null);
        }
      } catch (e) {
        if (my === reqId.current) setError(e instanceof Error ? e.message : "Error inesperado");
      } finally {
        if (my === reqId.current) setLoading(false);
      }
    },
    // depsKey representa `deps` (serializado) para re-disparar la carga cuando cambian.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, depsKey],
  );

  useEffect(() => {
    // Carga inicial / al cambiar dependencias (patrón de sincronización con sistema externo).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [run]);

  return { data, setData, error, loading, reload: run };
}
