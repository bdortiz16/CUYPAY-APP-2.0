"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Isotype } from "@/components/site/Logo";
import type { Permission } from "@/lib/admin/rbac";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import { AdminSessionProvider, useSession, useStreamEvent } from "@/lib/admin/session";
import { cx, css as s, errorMessage, ToastProvider, useToast } from "./ui";

const NAV: { group: string; items: { href: string; label: string; perm: Permission; countKey?: "compliance" }[] }[] = [
  {
    group: "Operación",
    items: [
      { href: "/admin-portal/", label: "Resumen", perm: "dashboard:read" },
      { href: "/admin-portal/customers/", label: "Clientes", perm: "dashboard:read" },
      { href: "/admin-portal/transactions/", label: "Transacciones", perm: "dashboard:read" },
      { href: "/admin-portal/compliance/", label: "Cumplimiento", perm: "compliance:read", countKey: "compliance" },
    ],
  },
  {
    group: "Finanzas",
    items: [
      { href: "/admin-portal/treasury/", label: "Tesorería", perm: "treasury:read" },
      { href: "/admin-portal/limits/", label: "Límites", perm: "dashboard:read" },
    ],
  },
  {
    group: "Sistema",
    items: [
      { href: "/admin-portal/providers/", label: "Conexiones", perm: "dashboard:read" },
      { href: "/admin-portal/audit/", label: "Audit log", perm: "audit:read" },
      { href: "/admin-portal/users/", label: "Usuarios admin", perm: "admins:manage" },
    ],
  },
];

const LOGIN_PATH = "/admin-portal/login/";

function normalize(p: string | null) {
  if (!p) return "/";
  return p.endsWith("/") ? p : `${p}/`;
}

export function AdminRoot({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.root}>
      <AdminSessionProvider>
        <ToastProvider>
          <Gate>{children}</Gate>
        </ToastProvider>
      </AdminSessionProvider>
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { ready, admin } = useSession();
  const pathname = normalize(usePathname());
  const router = useRouter();
  const isLogin = pathname === LOGIN_PATH;

  useEffect(() => {
    if (!ready) return;
    if (!admin && !isLogin) router.replace(LOGIN_PATH);
    if (admin && isLogin) router.replace("/admin-portal/");
  }, [ready, admin, isLogin, router]);

  if (isLogin) return <>{children}</>;
  if (!ready || !admin) return <div className={s.loaderPage}>Cargando portal…</div>;
  return <Shell pathname={pathname}>{children}</Shell>;
}

function Shell({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const { admin, can, logout, streamStatus, expiresAt, mock, api } = useSession();
  const [open, setOpen] = useState(false);
  const [complianceCount, setComplianceCount] = useState(0);
  const [pwOpen, setPwOpen] = useState(false);
  const canCompliance = can("compliance:read");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(iv);
  }, []);

  const refreshCounts = useCallback(async () => {
    if (!api || !canCompliance) return;
    try {
      const [b, a] = await Promise.all([api.beneficiaries("pending_review"), api.alerts({ status: "open" })]);
      setComplianceCount(b.items.length + a.items.length);
    } catch {
      /* sin conteo */
    }
  }, [api, canCompliance]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCounts();
  }, [refreshCounts, pathname]);
  useStreamEvent(["compliance.alert", "beneficiary.review_required"], () => void refreshCounts());

  const current = NAV.flatMap((g) => g.items)
    .filter((i) => (i.href === "/admin-portal/" ? pathname === i.href : pathname.startsWith(i.href)))
    .at(0);
  const minsLeft = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 60_000)) : 0;
  const initials = (admin?.name ?? "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className={s.shell}>
      <aside className={cx(s.sidebar, open && s.sidebarOpen)} aria-label="Navegación del portal">
        <div className={s.brand}>
          <Isotype size={24} color="#ADCBC8" />
          <span>
            CUYPAY
            <small>Back-office</small>
          </span>
        </div>
        {NAV.map((g) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <nav key={g.group} className={s.navGroup} aria-label={g.group}>
              <div className={s.navLabel}>{g.group}</div>
              {items.map((i) => (
                <Link
                  key={i.href}
                  href={i.href}
                  className={cx(s.navItem, current?.href === i.href && s.navItemOn)}
                  onClick={() => setOpen(false)}
                  aria-current={current?.href === i.href ? "page" : undefined}
                >
                  <span>{i.label}</span>
                  {i.countKey === "compliance" && complianceCount > 0 ? <span className={s.navCount}>{complianceCount}</span> : null}
                </Link>
              ))}
            </nav>
          );
        })}
        <div className={s.sideFoot}>
          {mock ? "Modo demo · datos simulados" : "Conectado a api.cuypay.com"}
          <br />
          <Link href="/" className={s.faint}>
            ← Ir a cuypay.com
          </Link>
        </div>
      </aside>

      <div className={s.main}>
        {mock ? (
          <div className={s.mockBanner}>
            Modo demo: los datos y eventos en vivo son simulados en tu navegador. Define NEXT_PUBLIC_ADMIN_API_BASE para usar el backend real.
          </div>
        ) : null}
        <header className={s.topbar}>
          <button type="button" className={cx(s.btn, s.btnGhost, s.menuBtn)} onClick={() => setOpen((o) => !o)} aria-label="Abrir menú">
            ☰
          </button>
          <div className={s.topTitle}>{current?.label ?? "Portal"}</div>
          <span className={s.stream} title="Conexión de eventos en tiempo real (SSE)">
            <span
              className={cx(
                s.dot,
                streamStatus === "open" && s.dotOk,
                streamStatus === "connecting" && s.dotWarn,
                streamStatus === "error" && s.dotBad,
              )}
            />
            {streamStatus === "open" ? "En vivo" : streamStatus === "connecting" ? "Conectando" : streamStatus === "error" ? "Reconectando" : "Sin conexión"}
          </span>
          <span className={cx(s.faint, s.num)} title="La sesión dura 30 minutos, sin renovación automática">
            Sesión {minsLeft} min
          </span>
          <div className={s.user}>
            <span className={s.avatar} aria-hidden>
              {initials}
            </span>
            <span className={s.userMeta}>
              <span>{admin?.name}</span>
              <span>
                {admin ? ROLE_LABEL[admin.role] : ""} · {admin?.email}
              </span>
            </span>
          </div>
          <button type="button" id="admin-password" className={cx(s.btn, s.btnSm, s.btnGhost)} onClick={() => setPwOpen(true)}>
            Contraseña
          </button>
          <button type="button" id="admin-logout" className={cx(s.btn, s.btnSm)} onClick={() => void logout()}>
            Salir
          </button>
        </header>
        <div className={s.content}>{children}</div>
      </div>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

/** POST /admin/me/password: no requiere `reason` (se audita igual). */
function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const reset = () => {
    setCur("");
    setNext("");
    setConfirm("");
    setErr(null);
    setBusy(false);
  };

  const valid = cur.length > 0 && next.length >= 12 && next === confirm && next !== cur;

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby="pw-dialog-title"
      onClose={() => {
        reset();
        onClose();
      }}
    >
      {open ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!api || !valid) return;
            setBusy(true);
            setErr(null);
            try {
              await api.changePassword(cur, next);
              toast("Contraseña actualizada");
              reset();
              onClose();
            } catch (ex) {
              setErr(errorMessage(ex));
              setBusy(false);
            }
          }}
        >
          <div className={s.dialogHead}>
            <h2 id="pw-dialog-title">Cambiar contraseña</h2>
            <p>Mínimo 12 caracteres. Usa un gestor de contraseñas.</p>
          </div>
          <div className={s.dialogBody}>
            <label className={s.field}>
              <span>Contraseña actual</span>
              <input className={s.input} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
            </label>
            <label className={s.field}>
              <span>Nueva contraseña</span>
              <input className={s.input} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label className={s.field}>
              <span>Confirmar nueva contraseña</span>
              <input className={s.input} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {next && next.length < 12 ? <div className={s.hint}>Faltan {12 - next.length} caracteres.</div> : null}
            {confirm && next !== confirm ? <div className={s.hint}>Las contraseñas no coinciden.</div> : null}
            {err ? <div className={s.error}>{err}</div> : null}
          </div>
          <div className={s.dialogFoot}>
            <button type="button" className={s.btn} onClick={() => ref.current?.close()} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className={cx(s.btn, s.btnPrimary)} disabled={busy || !valid}>
              {busy ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/** Bloque para páginas a las que el rol no tiene acceso. */
export function RequirePerm({ perm, children }: { perm: Permission; children: React.ReactNode }) {
  const { can } = useSession();
  if (!can(perm))
    return (
      <div className={s.panel}>
        <div className={s.empty}>Tu rol no tiene acceso a esta sección.</div>
      </div>
    );
  return <>{children}</>;
}
