"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { formatMinor } from "@/lib/format";
import { ApiError, type Currency } from "@/lib/admin/types";
import s from "./admin.module.css";

export { s as css };

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Mensaje legible para errores del Admin API (403 FORBIDDEN, 403 ACCOUNT_FROZEN, 409 CONFLICT…). */
export function errorMessage(ex: unknown, fallback = "No se pudo completar la acción."): string {
  if (ex instanceof ApiError) {
    switch (ex.code) {
      case "FORBIDDEN":
        return "Tu rol no tiene permiso para esta acción.";
      case "ACCOUNT_FROZEN":
        return "La cuenta del cliente está congelada.";
      case "CONFLICT":
        return ex.message && !ex.message.startsWith("Error ") ? ex.message : "Conflicto: el registro cambió o la acción ya se aplicó. Recarga e inténtalo de nuevo.";
      case "VALIDATION_ERROR":
        return ex.message || "Hay datos inválidos.";
      default:
        return ex.message || fallback;
    }
  }
  return ex instanceof Error ? ex.message : fallback;
}

// ---------- Badges ----------
type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "neutral";
const TONE: Record<Tone, string> = {
  ok: s.bOk,
  warn: s.bWarn,
  bad: s.bBad,
  info: s.bInfo,
  accent: s.bAccent,
  neutral: "",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={cx(s.badge, TONE[tone])} title={title}>
      {children}
    </span>
  );
}

const STATUS_MAP: Record<string, [Tone, string]> = {
  // KYC
  approved: ["ok", "Aprobado"],
  pending: ["warn", "Pendiente"],
  rejected: ["bad", "Rechazado"],
  retry: ["warn", "Reintentar"],
  not_started: ["neutral", "Sin iniciar"],
  // cliente
  active: ["ok", "Activo"],
  frozen: ["bad", "Congelado"],
  disabled: ["neutral", "Deshabilitado"],
  // tx
  completed: ["ok", "Completada"],
  failed: ["bad", "Fallida"],
  reversed: ["info", "Reversada"],
  // beneficiario
  pending_review: ["warn", "En revisión"],
  // alertas
  open: ["accent", "Abierta"],
  resolved: ["neutral", "Resuelta"],
  // proveedores
  operational: ["ok", "Operativo"],
  degraded: ["warn", "Degradado"],
  down: ["bad", "Caído"],
  // tesorería
  ok: ["ok", "OK"],
  stale: ["warn", "Desactualizado"],
  error: ["bad", "Error"],
  breaks: ["bad", "Con diferencias"],
  running: ["info", "En curso"],
  never: ["neutral", "Nunca"],
  // riesgo
  low: ["ok", "Bajo"],
  medium: ["warn", "Medio"],
  high: ["bad", "Alto"],
  // aml
  clear: ["ok", "Limpio"],
  hit: ["bad", "Coincidencia"],
  review: ["warn", "Revisar"],
};

export function StatusBadge({ value, prefix }: { value: string; prefix?: string }) {
  const [tone, label] = STATUS_MAP[value] ?? ["neutral", value];
  return (
    <Badge tone={tone}>
      {prefix ? `${prefix} ` : ""}
      {label}
    </Badge>
  );
}

export const TX_TYPE: Record<string, string> = { deposit: "Depósito", transfer: "Envío", conversion: "Conversión" };
export const TIER: Record<string, string> = { basic: "Básico", full: "Completo" };
export const OPERATION: Record<string, string> = { transfer_out: "Envíos", conversion: "Conversiones", deposit_in: "Depósitos" };
export const PERIOD: Record<string, string> = { daily: "Diario", monthly: "Mensual", annual: "Anual" };
export const ALERT_TYPE: Record<string, string> = {
  deposit_over_limit: "Depósito sobre límite",
  aml_hit: "Coincidencia AML",
  velocity: "Velocidad",
  large_transaction: "Transacción grande",
  multiple_devices: "Múltiples dispositivos",
  structuring: "Fraccionamiento",
};
export const RESOLUTION: Record<string, string> = {
  false_positive: "Falso positivo",
  customer_contacted: "Cliente contactado",
  frozen: "Cliente congelado",
  reported: "Reportado",
};

export function Money({ minor, currency, sign, className }: { minor: number; currency: Currency; sign?: boolean; className?: string }) {
  return <span className={cx(s.num, className)}>{formatMinor(minor, currency, { sign, decimals: true })}</span>;
}

// ---------- Contenedores ----------
export function Panel({
  title,
  actions,
  children,
  bodyless,
  id,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  bodyless?: boolean;
  id?: string;
}) {
  return (
    <section className={s.panel} id={id}>
      {title || actions ? (
        <header className={s.panelHead}>
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions ? <div className={s.row}>{actions}</div> : null}
        </header>
      ) : null}
      {bodyless ? children : <div className={s.panelBody}>{children}</div>}
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={s.pageHead}>
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className={s.row}>{actions}</div> : null}
    </div>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className={s.kpi}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiValue}>{value}</div>
      {sub ? <div className={s.kpiSub}>{sub}</div> : null}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={s.error} role="alert">
      <div className={s.spread}>
        <span>{message}</span>
        {onRetry ? (
          <button type="button" className={cx(s.btn, s.btnSm)} onClick={onRetry}>
            Reintentar
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={s.stack} style={{ padding: 16 }} aria-busy="true" aria-label="Cargando">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skeleton} style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={s.empty}>{children}</div>;
}

export function LimitBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className={cx(s.bar, pct >= 90 ? s.barBad : pct >= 70 && s.barWarn)} title={`${pct} %`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Botón que respeta RBAC: si no hay permiso se muestra deshabilitado con explicación. */
export function GuardedButton({
  allowed,
  hideIfDenied,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { allowed: boolean; hideIfDenied?: boolean }) {
  if (!allowed && hideIfDenied) return null;
  return (
    <button
      type="button"
      {...rest}
      className={cx(s.btn, className)}
      disabled={!allowed || rest.disabled}
      title={!allowed ? "Tu rol no tiene permiso para esta acción" : rest.title}
    >
      {children}
    </button>
  );
}

// ---------- Diálogo con motivo obligatorio ----------
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  danger,
  children,
  onConfirm,
  onClose,
  reasonLabel = "Motivo (queda en el audit log)",
  canConfirm = true,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  children?: React.ReactNode;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  reasonLabel?: string;
  canConfirm?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const reset = () => {
    setReason("");
    setErr(null);
    setBusy(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3 || reason.trim().length > 1000) {
      setErr("El motivo debe tener entre 3 y 1000 caracteres.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
      reset();
      onClose();
    } catch (ex) {
      setErr(errorMessage(ex));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      onClose={() => {
        reset();
        onClose();
      }}
      aria-labelledby="reason-dialog-title"
    >
      {open ? (
        <form onSubmit={submit}>
          <div className={s.dialogHead}>
            <h2 id="reason-dialog-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <div className={s.dialogBody}>
            {children}
            <label className={s.field}>
              <span>{reasonLabel}</span>
              <textarea
                id="reason-input"
                className={s.textarea}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej.: Solicitud del cliente por chat #48211"
                required
                minLength={3}
                maxLength={1000}
                autoFocus
              />
            </label>
            {err ? <div className={s.error}>{err}</div> : null}
          </div>
          <div className={s.dialogFoot}>
            <button type="button" className={s.btn} onClick={() => ref.current?.close()} disabled={busy}>
              Cancelar
            </button>
            <button
              type="submit"
              id="reason-confirm"
              className={cx(s.btn, danger ? s.btnSolidDanger : s.btnPrimary)}
              disabled={busy || !canConfirm || reason.trim().length < 3}
            >
              {busy ? "Procesando…" : confirmLabel}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

// ---------- Toasts ----------
interface Toast {
  id: number;
  text: string;
  tone: "ok" | "bad" | "info";
}
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className={s.toasts} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx(s.toast, t.tone === "ok" && s.toastOk, t.tone === "bad" && s.toastBad)}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Pager({
  count,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  label = "resultados",
}: {
  count: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
}) {
  return (
    <div className={s.pager}>
      <span>
        {count} {label} en esta página
      </span>
      <div className={s.row}>
        <button type="button" className={cx(s.btn, s.btnSm)} onClick={onPrev} disabled={!hasPrev}>
          ← Anterior
        </button>
        <button type="button" className={cx(s.btn, s.btnSm)} onClick={onNext} disabled={!hasNext}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}

/** Paginación por cursor: guarda la pila de cursores para poder volver. */
export function useCursorPager(resetKey: string) {
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setStack([null]);
  }
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    hasPrev: stack.length > 1,
    next: (c: string | null) => c && setStack((st) => [...st, c]),
    prev: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
  };
}
