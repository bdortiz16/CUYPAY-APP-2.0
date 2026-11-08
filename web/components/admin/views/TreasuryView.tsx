"use client";

import { useState } from "react";
import { customerRateFrom, quote } from "@/lib/fx";
import { formatDateTime, formatMinor, parseToMinor, pct, timeAgo } from "@/lib/format";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { FxConfig, FxConfigInput } from "@/lib/admin/types";
import { RequirePerm } from "../AdminShell";
import { css as s, cx, ErrorBox, GuardedButton, Kpi, Money, PageHead, Panel, ReasonDialog, Skeleton, StatusBadge, useToast } from "../ui";

const BREAK_LABEL: Record<string, string> = {
  missing_in_ledger: "Falta en ledger",
  missing_in_provider: "Falta en proveedor",
  amount_mismatch: "Monto distinto",
  status_mismatch: "Estado distinto",
};

export function TreasuryView() {
  return (
    <RequirePerm perm="treasury:read">
      <Treasury />
    </RequirePerm>
  );
}

function Treasury() {
  const { can, api } = useSession();
  const toast = useToast();
  const { data: t, setData, error, loading, reload } = useLoad((a) => a.treasury(), []);
  const fx = useLoad((a) => a.fx(), []);
  const [reconOpen, setReconOpen] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [form, setForm] = useState({ spreadBps: "", feeBps: "", minFee: "", minAmount: "", maxAmount: "", enabled: true });

  useStreamEvent(["treasury.updated"], (e) => {
    if (e.type === "treasury.updated") setData(e.data);
  });

  const manage = can("treasury:write");

  if (error && !t) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !t) return <Panel title="Tesorería"><Skeleton rows={8} /></Panel>;
  if (!t || !api) return null;

  const openFx = (f: FxConfig) => {
    setForm({
      spreadBps: String(f.spreadBps),
      feeBps: String(f.feeBps),
      minFee: String(f.minFeeMinor / 100),
      minAmount: String(f.minAmountMinor / 100),
      maxAmount: String(f.maxAmountMinor / 100),
      enabled: f.enabled,
    });
    setFxOpen(true);
  };

  const f = fx.data;
  const previewSpread = Number.parseInt(form.spreadBps || "0", 10);
  const previewFee = Number.parseInt(form.feeBps || "0", 10);
  const previewRate = f ? customerRateFrom(f.midRate, Number.isFinite(previewSpread) ? previewSpread : 0) : 0;
  const previewQuote = f
    ? quote(100_000_000, { customerRate: previewRate, feeBps: Number.isFinite(previewFee) ? previewFee : 0, minFeeMinor: parseToMinor(form.minFee) ?? 0 })
    : null;

  return (
    <>
      <PageHead
        title="Tesorería"
        sub={<>Saldos en proveedores vs. pasivos con clientes (ledger) · {timeAgo(t.asOf)}</>}
        actions={
          <>
            <button type="button" className={s.btn} onClick={() => void reload()}>
              Actualizar
            </button>
            <GuardedButton allowed={manage} className={s.btnPrimary} onClick={() => setReconOpen(true)} id="treasury-reconcile" disabled={t.reconciliation.status === "running"}>
              {t.reconciliation.status === "running" ? "Conciliando…" : "Correr conciliación"}
            </GuardedButton>
          </>
        }
      />

      <div className={s.kpis}>
        {t.coverage.map((c) => (
          <Kpi
            key={c.currency}
            label={`Cobertura ${c.currency}`}
            value={<span className={c.ratio < 1 ? s.neg : undefined}>{pct(c.ratio, 2)}</span>}
            sub={
              <>
                Diferencia{" "}
                <Money minor={c.differenceMinor} currency={c.currency} sign className={c.differenceMinor < 0 ? s.neg : s.pos} />
              </>
            }
          />
        ))}
        <Kpi label="Ingresos hoy" value={formatMinor(t.revenue.todayMinor, t.revenue.currency)} />
        <Kpi label="Ingresos 30 días" value={formatMinor(t.revenue.monthMinor, t.revenue.currency)} />
      </div>

      <div className={s.grid2}>
        <Panel title="Cuentas en proveedores" bodyless>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Cuenta</th>
                <th className={s.right}>Saldo proveedor</th>
                <th className={s.right}>Ledger</th>
                <th className={s.right}>Diferencia</th>
                <th>Sincronizado</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {t.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    <div className={cx(s.mono, s.faint)}>{a.id}</div>
                  </td>
                  <td className={s.right}>
                    {a.providerBalanceMinor === null ? <span className={s.faint}>—</span> : <Money minor={a.providerBalanceMinor} currency={a.currency} />}
                  </td>
                  <td className={s.right}>
                    <Money minor={a.ledgerBalanceMinor} currency={a.currency} />
                  </td>
                  <td className={s.right}>
                    {a.differenceMinor === null ? (
                      <span className={s.faint}>—</span>
                    ) : (
                      <Money minor={a.differenceMinor} currency={a.currency} sign className={a.differenceMinor < 0 ? s.neg : a.differenceMinor > 0 ? s.pos : undefined} />
                    )}
                  </td>
                  <td className={s.faint}>{timeAgo(a.lastSyncedAt)}</td>
                  <td>
                    <StatusBadge value={a.status} />
                    {a.error ? <div className={cx(s.faint, s.neg)} style={{ marginTop: 4, maxWidth: 260 }}>{a.error}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Cobertura" bodyless>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Moneda</th>
                <th className={s.right}>Proveedor</th>
                <th className={s.right}>Pasivos (clientes)</th>
                <th className={s.right}>Diferencia</th>
                <th className={s.right}>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {t.coverage.map((c) => (
                <tr key={c.currency}>
                  <td>{c.currency}</td>
                  <td className={s.right}>
                    <Money minor={c.providerMinor} currency={c.currency} />
                  </td>
                  <td className={s.right}>
                    <Money minor={c.liabilitiesMinor} currency={c.currency} />
                  </td>
                  <td className={s.right}>
                    <Money minor={c.differenceMinor} currency={c.currency} sign className={c.differenceMinor < 0 ? s.neg : s.pos} />
                  </td>
                  <td className={cx(s.right, s.num, c.ratio < 1 ? s.neg : s.pos)}>{pct(c.ratio, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className={s.grid2}>
        <Panel
          title="Conciliación"
          actions={
            <span className={s.row}>
              <StatusBadge value={t.reconciliation.status} />
              <span className={s.faint}>{t.reconciliation.lastRunAt ? `Última: ${formatDateTime(t.reconciliation.lastRunAt)}` : "Nunca"}</span>
            </span>
          }
          bodyless
        >
          {t.reconciliation.breaks.length === 0 ? (
            <div className={s.empty}>{t.reconciliation.status === "running" ? "Conciliación en curso…" : "Sin diferencias: ledger y proveedores cuadran."}</div>
          ) : (
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Referencia</th>
                  <th>Detalle</th>
                  <th className={s.right}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {t.reconciliation.breaks.map((b, i) => (
                  <tr key={i}>
                    <td>{BREAK_LABEL[b.kind] ?? b.kind}</td>
                    <td className={s.mono}>{b.reference}</td>
                    <td className={s.faint}>{b.detail}</td>
                    <td className={s.right}>
                      <Money minor={b.amountMinor} currency={b.currency} className={s.neg} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Configuración FX · COP/BRL"
          actions={
            f ? (
              <GuardedButton allowed={manage} className={s.btnSm} onClick={() => openFx(f)} id="fx-edit">
                Editar
              </GuardedButton>
            ) : null
          }
        >
          {fx.error ? (
            <ErrorBox message={fx.error} onRetry={() => void fx.reload()} />
          ) : !f ? (
            <Skeleton rows={5} />
          ) : (
            <dl className={s.dl}>
              <dt>Estado</dt>
              <dd>{f.enabled ? <StatusBadge value="active" /> : <StatusBadge value="disabled" />}</dd>
              <dt>Tasa media</dt>
              <dd className={s.mono}>{f.midRate.toFixed(8)}</dd>
              <dt>Tasa cliente</dt>
              <dd className={s.mono}>{f.customerRate.toFixed(8)}</dd>
              <dt>Spread</dt>
              <dd className={s.num}>{f.spreadBps} bps</dd>
              <dt>Comisión</dt>
              <dd className={s.num}>
                {f.feeBps} bps · mín. {formatMinor(f.minFeeMinor, "COP")}
              </dd>
              <dt>Monto por operación</dt>
              <dd className={s.num}>
                {formatMinor(f.minAmountMinor, "COP")} – {formatMinor(f.maxAmountMinor, "COP")}
              </dd>
              <dt>Actualizado</dt>
              <dd>
                {formatDateTime(f.updatedAt)} · {f.updatedBy}
              </dd>
            </dl>
          )}
        </Panel>
      </div>

      <ReasonDialog
        open={reconOpen}
        title="Correr conciliación"
        description="Compara el ledger con los saldos y movimientos de los proveedores. Puede tardar unos segundos."
        confirmLabel="Conciliar"
        onClose={() => setReconOpen(false)}
        onConfirm={async (reason) => {
          await api.reconcile(reason);
          toast("Conciliación iniciada");
          void reload(true);
        }}
      />

      <ReasonDialog
        open={fxOpen}
        title="Editar configuración FX"
        confirmLabel="Guardar cambios"
        onClose={() => setFxOpen(false)}
        onConfirm={async (reason) => {
          const minFeeMinor = parseToMinor(form.minFee);
          const minAmountMinor = parseToMinor(form.minAmount);
          const maxAmountMinor = parseToMinor(form.maxAmount);
          const spreadBps = Number.parseInt(form.spreadBps, 10);
          const feeBps = Number.parseInt(form.feeBps, 10);
          if ([minFeeMinor, minAmountMinor, maxAmountMinor].some((v) => v === null) || !Number.isFinite(spreadBps) || !Number.isFinite(feeBps))
            throw new Error("Revisa los campos: hay valores inválidos.");
          // PUT /treasury/fx acepta campos parciales: solo enviamos lo que cambió.
          const next = { spreadBps, feeBps, minFeeMinor: minFeeMinor!, minAmountMinor: minAmountMinor!, maxAmountMinor: maxAmountMinor!, enabled: form.enabled };
          const changes: FxConfigInput = {};
          for (const k of Object.keys(next) as (keyof typeof next)[]) {
            if (!f || f[k] !== next[k]) (changes as Record<string, unknown>)[k] = next[k];
          }
          if (Object.keys(changes).length === 0) throw new Error("No hay cambios para guardar.");
          await api.updateFx(changes, reason);
          toast("Configuración FX actualizada");
          void fx.reload(true);
        }}
      >
        <div className={s.grid2} style={{ gap: 10 }}>
          <label className={s.field}>
            <span>Spread (bps)</span>
            <input className={s.input} inputMode="numeric" value={form.spreadBps} onChange={(e) => setForm({ ...form, spreadBps: e.target.value.replace(/\D/g, "") })} />
          </label>
          <label className={s.field}>
            <span>Comisión (bps)</span>
            <input className={s.input} inputMode="numeric" value={form.feeBps} onChange={(e) => setForm({ ...form, feeBps: e.target.value.replace(/\D/g, "") })} />
          </label>
          <label className={s.field}>
            <span>Comisión mínima (COP)</span>
            <input className={s.input} inputMode="numeric" value={form.minFee} onChange={(e) => setForm({ ...form, minFee: e.target.value })} />
          </label>
          <label className={s.field}>
            <span>Monto mínimo (COP)</span>
            <input className={s.input} inputMode="numeric" value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: e.target.value })} />
          </label>
          <label className={s.field}>
            <span>Monto máximo (COP)</span>
            <input className={s.input} inputMode="numeric" value={form.maxAmount} onChange={(e) => setForm({ ...form, maxAmount: e.target.value })} />
          </label>
          <label className={s.check} style={{ alignSelf: "end", height: 32 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Conversiones habilitadas
          </label>
        </div>
        {previewQuote ? (
          <div className={s.hint}>
            Vista previa: tasa cliente <span className={s.mono}>{previewRate.toFixed(8)}</span> · $ 1.000.000 → comisión{" "}
            {formatMinor(previewQuote.feeMinor, "COP")} → recibe {formatMinor(previewQuote.toAmountMinor, "BRL")}
          </div>
        ) : null}
      </ReasonDialog>
    </>
  );
}
