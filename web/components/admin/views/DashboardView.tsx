"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { formatInt, formatMinor, pct, timeAgo } from "@/lib/format";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { StreamEvent } from "@/lib/admin/types";
import { SeriesChart } from "../SeriesChart";
import { css as s, cx, ErrorBox, Kpi, PageHead, Panel, Skeleton, StatusBadge, TX_TYPE, useToast } from "../ui";

function describe(e: StreamEvent): { title: React.ReactNode; sub: string; tone: string } {
  switch (e.type) {
    case "transaction.created":
    case "transaction.updated": {
      const t = e.data;
      return {
        title: (
          <>
            {TX_TYPE[t.type]} {e.type === "transaction.created" ? "nueva" : "actualizada"} ·{" "}
            <Link href={`/admin-portal/transactions/?id=${t.id}`}>{formatMinor(t.amountMinor, t.currency)}</Link>
          </>
        ),
        sub: `${t.customerName} · ${t.status}`,
        tone: t.status === "failed" ? "#D6363B" : t.type === "deposit" ? "#4cc79a" : "#ADCBC8",
      };
    }
    case "customer.created":
      return {
        title: (
          <>
            Cliente nuevo · <Link href={`/admin-portal/customers/?id=${e.data.id}`}>{`${e.data.firstName} ${e.data.lastName}`}</Link>
          </>
        ),
        sub: "Registro completado, KYC pendiente",
        tone: "#197168",
      };
    case "customer.updated":
      return {
        title: (
          <>
            Cliente actualizado · <Link href={`/admin-portal/customers/?id=${e.data.id}`}>{`${e.data.firstName} ${e.data.lastName}`}</Link>
          </>
        ),
        sub: `${e.data.status === "frozen" ? "Congelado" : "Activo"} · nivel ${e.data.tier}`,
        tone: e.data.status === "frozen" ? "#D6363B" : "#197168",
      };
    case "kyc.updated":
      return {
        title: (
          <>
            KYC {e.data.status} · <Link href={`/admin-portal/customers/?id=${e.data.customerId}`}>ver cliente</Link>
          </>
        ),
        sub: `Nivel ${e.data.tier}`,
        tone: "#4cc79a",
      };
    case "compliance.alert":
      return {
        title: <Link href="/admin-portal/compliance/?tab=alerts">Alerta: {e.data.description}</Link>,
        sub: `${e.data.customerName} · severidad ${e.data.severity}`,
        tone: "#FA6465",
      };
    case "beneficiary.review_required":
      return { title: <Link href="/admin-portal/compliance/">Beneficiario en revisión AML</Link>, sub: e.data.holderName, tone: "#e8b04a" };
    case "provider.status":
      return { title: `${e.data.name}: ${e.data.status}`, sub: `${e.data.latencyMs} ms`, tone: "#ADCBC8" };
    case "treasury.updated":
      return { title: "Tesorería actualizada", sub: `Conciliación: ${e.data.reconciliation.status}`, tone: "#ADCBC8" };
    default:
      return { title: e.type, sub: "", tone: "#ADCBC8" };
  }
}

function eventTime(e: StreamEvent): string {
  if (e.type === "customer.updated") return e.data.lastActiveAt ?? new Date().toISOString();
  const d = e.data as { updatedAt?: string; createdAt?: string; lastCheckAt?: string; asOf?: string; at?: string };
  return d.updatedAt ?? d.createdAt ?? d.lastCheckAt ?? d.asOf ?? d.at ?? new Date().toISOString();
}

export function DashboardView() {
  const { feed, can, api } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad((api) => api.dashboard(), []);
  const fx = useLoad((api) => api.fx(), []);
  const [togglingCorridor, setTogglingCorridor] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleBrazil = async () => {
    if (!fx.data || !api) return;
    setTogglingCorridor(true);
    try {
      const nextState = !fx.data.enabled;
      await api.updateFx({ enabled: nextState }, nextState ? "Habilitar corredor Brasil (PIX)" : "Deshabilitar corredor Brasil (Solo Bre-B)");
      toast(nextState ? "Corredor Brasil (PIX / BRL) habilitado" : "Corredor Brasil desactivado. Operando exclusivamente con Bre-B.");
      void fx.reload(true);
      void reload(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Error al cambiar estado");
    } finally {
      setTogglingCorridor(false);
    }
  };

  useStreamEvent(
    ["transaction.created", "transaction.updated", "customer.created", "customer.updated", "kyc.updated", "compliance.alert", "provider.status", "treasury.updated"],
    () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(true), 800);
    },
  );

  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Panel title="Resumen"><Skeleton rows={6} /></Panel>;
  if (!data) return null;

  const d = data;
  const q = d.queues;

  return (
    <>
      <PageHead
        title="Resumen de hoy"
        sub={<>Actualizado {timeAgo(d.generatedAt)} · Hora de Bogotá</>}
        actions={
          <button type="button" className={s.btn} onClick={() => void reload()}>
            Actualizar
          </button>
        }
      />

      <div className={s.kpis}>
        <Kpi label="Clientes" value={formatInt(d.customers.total)} sub={`+${d.customers.newToday} hoy · ${d.customers.frozen} congelados`} />
        <Kpi label="KYC aprobado" value={formatInt(d.customers.kycApproved)} sub={`${d.customers.kycPending} pendientes`} />
        <Kpi label="Depósitos hoy" value={formatMinor(d.today.deposits.volumeMinor, "COP")} sub={`${d.today.deposits.count} operaciones`} />
        <Kpi label="Envíos hoy" value={formatMinor(d.today.transfers.volumeMinor, "COP")} sub={`${d.today.transfers.count} operaciones`} />
        <Kpi
          label="Conversiones hoy"
          value={formatMinor(d.today.conversions.fromVolumeMinor, "COP")}
          sub={`${d.today.conversions.count} → ${formatMinor(d.today.conversions.toVolumeMinor, "BRL")}`}
        />
        <Kpi label="Ingresos hoy" value={formatMinor(d.today.revenueMinor, d.today.revenueCurrency)} sub="Comisiones cobradas" />
      </div>

      <div className={s.gridMain}>
        <Panel title="Volumen diario · últimos 30 días">
          <SeriesChart series={d.series} />
        </Panel>

        <div className={s.stack} style={{ gap: 18 }}>
          <Panel title="Colas pendientes" bodyless>
            <table className={s.table}>
              <tbody>
                <tr>
                  <td>
                    <Link href="/admin-portal/compliance/">Beneficiarios en revisión AML</Link>
                  </td>
                  <td className={s.right}>
                    <span className={cx(s.num, q.amlReview ? s.neg : s.faint)} style={{ fontWeight: 700 }}>
                      {q.amlReview}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <Link href="/admin-portal/compliance/?tab=alerts">Alertas de cumplimiento abiertas</Link>
                  </td>
                  <td className={s.right}>
                    <span className={cx(s.num, q.complianceAlerts ? s.neg : s.faint)} style={{ fontWeight: 700 }}>
                      {q.complianceAlerts}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <Link href="/admin-portal/transactions/?status=failed">Transacciones fallidas (24 h)</Link>
                  </td>
                  <td className={s.right}>
                    <span className={cx(s.num, q.failedTransactions ? s.neg : s.faint)} style={{ fontWeight: 700 }}>
                      {q.failedTransactions}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>
          <Panel title="Corredores y Países" actions={<Link href="/admin-portal/treasury/">Ajustes</Link>}>
            <div className={s.stack} style={{ gap: 14 }}>
              <div className={s.spread} style={{ alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 22 }}>🇨🇴</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Colombia · Bre-B</div>
                    <div className={cx(s.faint, s.num)} style={{ fontSize: 11 }}>ACH Colombia · Llaves activas</div>
                  </div>
                </div>
                <StatusBadge value="operational" />
              </div>

              <div className={s.spread} style={{ alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 22 }}>🇧🇷</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Brasil · PIX / BRL</div>
                    <div className={cx(s.faint, s.num)} style={{ fontSize: 11 }}>
                      {fx.data?.enabled ? "Operativo (COP ⇄ BRL)" : "Desactivado (Solo Bre-B activo)"}
                    </div>
                  </div>
                </div>
                {can("treasury:write") ? (
                  <button
                    type="button"
                    className={cx(s.btn, fx.data?.enabled ? s.btnWarn : s.btnPrimary)}
                    style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer" }}
                    disabled={togglingCorridor || !fx.data}
                    onClick={toggleBrazil}
                  >
                    {togglingCorridor ? "Cambiando…" : fx.data?.enabled ? "Desactivar Brasil" : "Activar Brasil"}
                  </button>
                ) : (
                  <StatusBadge value={fx.data?.enabled ? "operational" : "disabled"} />
                )}
              </div>
            </div>
          </Panel>

          {can("treasury:read") ? (
            <Panel title="Cobertura de tesorería" actions={<Link href="/admin-portal/treasury/">Ver</Link>}>
              <div className={s.stack}>
                {d.treasury.coverage.map((c) => (
                  <div key={c.currency}>
                    <div className={s.spread}>
                      <span>{c.currency}</span>
                      <span className={cx(s.num, c.ratio < 1 ? s.neg : s.pos)} style={{ fontWeight: 700 }}>
                        {pct(c.ratio)}
                      </span>
                    </div>
                    <div className={cx(s.faint, s.num)} style={{ fontSize: 12 }}>
                      Proveedor {formatMinor(c.providerMinor, c.currency)} · Pasivos {formatMinor(c.liabilitiesMinor, c.currency)}
                    </div>
                  </div>
                ))}
                <div className={s.spread}>
                  <span className={s.muted}>Conciliación</span>
                  <StatusBadge value={d.treasury.reconciliation.status} />
                </div>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

      <div className={s.gridMain}>
        <Panel
          title={
            <h2>
              Actividad en vivo <span className={s.faint}>· SSE</span>
            </h2>
          }
          bodyless
        >
          {feed.length === 0 ? (
            <div className={s.empty}>Esperando eventos…</div>
          ) : (
            <ul className={s.feed}>
              {feed.map((e, i) => {
                const info = describe(e);
                return (
                  <li key={`${e.type}-${(e.data as { id?: string }).id ?? i}-${feed.length - i}`}>
                    <span className={s.feedIcon} style={{ background: info.tone }} />
                    <div>
                      <div>{info.title}</div>
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {info.sub}
                      </div>
                    </div>
                    <span className={s.faint} style={{ fontSize: 11.5 }}>
                      {timeAgo(eventTime(e))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Proveedores" actions={<Link href="/admin-portal/providers/">Detalle</Link>} bodyless>
          <table className={s.table}>
            <tbody>
              {d.providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className={cx(s.num, s.faint)}>{p.latencyMs} ms</td>
                  <td className={s.right}>
                    <StatusBadge value={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
