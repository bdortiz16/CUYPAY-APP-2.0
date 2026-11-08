"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AdminApi, StreamStatus } from "./api";
import { getApi, isMockMode, setAccessToken, setUnauthorizedHandler } from "./api";
import { can, type Permission } from "./rbac";
import type { Admin, StreamEvent } from "./types";

const STORAGE_KEY = "cuypay.admin.session";
const INACTIVITY_MS = 15 * 60_000; // cierre por inactividad

interface StoredSession {
  token: string;
  admin: Admin;
  expiresAt: number;
}

interface SessionCtx {
  ready: boolean;
  api: AdminApi | null;
  admin: Admin | null;
  expiresAt: number | null;
  mock: boolean;
  can: (p: Permission) => boolean;
  startSession: (token: string, expiresIn: number, admin: Admin) => void;
  logout: (why?: string) => Promise<void>;
  logoutReason: string | null;
  streamStatus: StreamStatus;
  feed: StreamEvent[];
  /** Escucha eventos del stream SSE (una sola conexión compartida). */
  onEvent: (fn: (e: StreamEvent) => void) => () => void;
}

const Ctx = createContext<SessionCtx | null>(null);

function readStored(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.token || s.expiresAt < Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function AdminSessionProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<AdminApi | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const [logoutReason, setLogoutReason] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("closed");
  const [feed, setFeed] = useState<StreamEvent[]>([]);
  const listeners = useRef(new Set<(e: StreamEvent) => void>());

  const clear = useCallback((why?: string) => {
    window.sessionStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    setSession(null);
    setFeed([]);
    setLogoutReason(why ?? null);
  }, []);

  useEffect(() => {
    let alive = true;
    getApi().then((a) => {
      if (!alive) return;
      const stored = readStored();
      if (stored) setAccessToken(stored.token);
      setApi(a);
      setSession(stored);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => clear("Tu sesión expiró. Inicia sesión de nuevo."));
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const logout = useCallback(
    async (why?: string) => {
      try {
        await api?.logout();
      } catch {
        /* el token puede estar vencido */
      }
      clear(why);
    },
    [api, clear],
  );

  // Expiración del token (30 min, sin refresh silencioso) + inactividad
  useEffect(() => {
    if (!session) return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const evs = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      if (Date.now() >= session.expiresAt) void logout("Tu sesión de 30 minutos terminó. Inicia sesión de nuevo.");
      else if (Date.now() - last > INACTIVITY_MS) void logout("Cerramos tu sesión por inactividad.");
    }, 10_000);
    return () => {
      clearInterval(iv);
      evs.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [session, logout]);

  // Stream SSE compartido
  useEffect(() => {
    if (!api || !session) return;
    const unsub = api.subscribe(
      (e) => {
        if (e.type !== "ping") setFeed((f) => [e, ...f].slice(0, 60));
        listeners.current.forEach((l) => l(e));
      },
      (st) => setStreamStatus(st),
    );
    return unsub;
  }, [api, session]);

  const startSession = useCallback(
    (token: string, expiresIn: number, admin: Admin) => {
      const s: StoredSession = { token, admin, expiresAt: Date.now() + expiresIn * 1000 };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      setAccessToken(token);
      setLogoutReason(null);
      setSession(s);
      // GET /admin/me trae `permissions` (fuente de verdad para el RBAC de la UI).
      api
        ?.me()
        .then((me) => {
          setSession((cur) => {
            if (!cur || cur.token !== token) return cur;
            const next = { ...cur, admin: { ...cur.admin, ...me } };
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            return next;
          });
        })
        .catch(() => {
          /* se usa la matriz por rol como respaldo */
        });
    },
    [api],
  );

  const onEvent = useCallback((fn: (e: StreamEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo<SessionCtx>(
    () => ({
      ready,
      api,
      admin: session?.admin ?? null,
      expiresAt: session?.expiresAt ?? null,
      mock: isMockMode(),
      can: (p) => can(session?.admin.role, p, session?.admin.permissions),
      startSession,
      logout,
      logoutReason,
      streamStatus,
      feed,
      onEvent,
    }),
    [ready, api, session, startSession, logout, logoutReason, streamStatus, feed, onEvent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession fuera de AdminSessionProvider");
  return v;
}

/** Ejecuta `fn` cuando llegue un evento SSE de los tipos indicados. */
export function useStreamEvent(types: StreamEvent["type"][], fn: (e: StreamEvent) => void) {
  const { onEvent } = useSession();
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  const key = types.join(",");
  useEffect(() => {
    const set = new Set(key.split(","));
    return onEvent((e) => {
      if (set.has(e.type)) ref.current(e);
    });
  }, [onEvent, key]);
}
