"use client";

import { useState } from "react";
import { Isotype } from "@/components/site/Logo";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import { useSession } from "@/lib/admin/session";
import type { Role } from "@/lib/admin/types";
import { cx, errorMessage, css as s } from "../ui";

const DEMO: { email: string; role: Role }[] = [
  { email: "owner@cuypay.com", role: "owner" },
  { email: "cumplimiento@cuypay.com", role: "compliance" },
  { email: "tesoreria@cuypay.com", role: "treasury" },
  { email: "soporte@cuypay.com", role: "support" },
  { email: "lectura@cuypay.com", role: "viewer" },
];

export function LoginView() {
  const { api, ready, startSession, mock, logoutReason } = useSession();
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.login(email.trim(), password);
      setMfaToken(r.mfaToken);
      setStep("mfa");
      setPassword("");
    } catch (ex) {
      setErr(errorMessage(ex, "No se pudo iniciar sesión."));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.mfa(mfaToken, code);
      startSession(r.accessToken, r.expiresIn, r.admin);
    } catch (ex) {
      setErr(errorMessage(ex, "Código inválido."));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={s.login}>
      <div className={s.loginCard}>
        <div className={s.row}>
          <Isotype size={30} color="#ADCBC8" />
          <strong style={{ letterSpacing: "0.08em" }}>CUYPAY</strong>
          <span className={s.faint}>Back-office</span>
        </div>

        {step === "password" ? (
          <form onSubmit={submitPassword} className={s.stack}>
            <h1>Iniciar sesión</h1>
            {logoutReason ? <div className={s.error}>{logoutReason}</div> : null}
            <label className={s.field}>
              <span>Correo corporativo</span>
              <input
                id="login-email"
                className={s.input}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nombre@cuypay.com"
                required
                autoFocus
              />
            </label>
            <label className={s.field}>
              <span>Contraseña</span>
              <input
                id="login-password"
                className={s.input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {err ? <div className={s.error}>{err}</div> : null}
            <button id="login-submit" type="submit" className={cx(s.btn, s.btnPrimary)} disabled={busy || !ready}>
              {busy ? "Verificando…" : "Continuar"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitMfa} className={s.stack}>
            <h1>Verificación en dos pasos</h1>
            <p className={s.muted}>Escribe el código de 6 dígitos de tu app autenticadora para {email}.</p>
            <label className={s.field}>
              <span>Código TOTP</span>
              <input
                id="login-totp"
                className={cx(s.input, s.otp)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                autoFocus
              />
            </label>
            {err ? <div className={s.error}>{err}</div> : null}
            <button id="login-verify" type="submit" className={cx(s.btn, s.btnPrimary)} disabled={busy || code.length !== 6}>
              {busy ? "Verificando…" : "Entrar"}
            </button>
            <button
              type="button"
              className={cx(s.btn, s.btnGhost)}
              onClick={() => {
                setStep("password");
                setCode("");
                setErr(null);
              }}
            >
              ← Usar otra cuenta
            </button>
          </form>
        )}

        {mock ? (
          <div className={s.demoBox}>
            <strong>Modo demo.</strong> Contraseña: cualquiera · TOTP: cualquier código de 6 dígitos (ej. <span className={s.mono}>123456</span>)
            <br />
            {DEMO.map((d, i) => (
              <span key={d.email}>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword("demo");
                    setStep("password");
                  }}
                >
                  {ROLE_LABEL[d.role]}
                </button>
                {i < DEMO.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        ) : (
          <p className={s.faint} style={{ fontSize: 12 }}>
            Acceso restringido a personal autorizado de CuyPay. Toda actividad queda registrada.
          </p>
        )}
      </div>
    </main>
  );
}
