"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { AdminBeneficiary, AlertResolution, ComplianceAlert } from "@/lib/admin/types";
import {
  ALERT_TYPE,
  Badge,
  css as s,
  cx,
  Empty,
  ErrorBox,
  GuardedButton,
  PageHead,
  Panel,
  ReasonDialog,
  RESOLUTION,
  Skeleton,
  StatusBadge,
  useToast,
} from "../ui";

export function ComplianceView() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = sp.get("tab") === "alerts" ? "alerts" : "aml";
  return (
    <>
      <PageHead title="Cumplimiento · SARLAFT" sub="Revisión AML de beneficiarios y alertas de monitoreo transaccional." />
      <div className={s.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "aml"}
          className={cx(s.tab, tab === "aml" && s.tabOn)}
          onClick={() => router.replace("/admin-portal/compliance/")}
        >
          Revisión AML
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "alerts"}
          className={cx(s.tab, tab === "alerts" && s.tabOn)}
          onClick={() => router.replace("/admin-portal/compliance/?tab=alerts")}
        >
          Alertas
        </button>
      </div>
      {tab === "aml" ? <AmlQueue /> : <Alerts />}
    </>
  );
}

function AmlQueue() {
  const { can, api } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState("pending_review");
  const { data, error, loading, reload } = useLoad((a) => a.beneficiaries(status), [status]);
  const [target, setTarget] = useState<{ b: AdminBeneficiary; decision: "approve" | "reject" } | null>(null);
  useStreamEvent(["beneficiary.review_required"], () => void reload(true));
  const allowed = can("compliance:decide");

  return (
    <Panel
      title="Beneficiarios"
      actions={
        <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="pending_review">En revisión</option>
          <option value="rejected">Rechazados</option>
          <option value="active">Activos</option>
          <option value="">Todos</option>
        </select>
      }
      bodyless
    >
      {error ? (
        <div style={{ padding: 16 }}>
          <ErrorBox message={error} onRetry={() => void reload()} />
        </div>
      ) : loading && !data ? (
        <Skeleton rows={5} />
      ) : !data || data.items.length === 0 ? (
        <Empty>{status === "pending_review" ? "No hay beneficiarios en revisión. 🎉" : "Sin resultados."}</Empty>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Titular / llave</th>
                <th>Cliente</th>
                <th>Resultado AML (Sartblock)</th>
                <th>Coincidencias</th>
                <th>Creado</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.slice(0, 200).map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.holderName}</strong>
                    <div className={s.faint} style={{ fontSize: 12 }}>
                      {b.bankName} · <span className={s.mono}>{b.alias}</span>
                    </div>
                  </td>
                  <td>
                    <Link href={`/admin-portal/customers/?id=${b.customerId}`}>{b.customerName}</Link>
                  </td>
                  <td>
                    <StatusBadge value={b.aml.result} />
                    <div className={cx(s.mono, s.faint)}>{b.aml.referenceId}</div>
                  </td>
                  <td>
                    {b.aml.matches.length === 0 ? (
                      <span className={s.faint}>—</span>
                    ) : (
                      <div className={s.stack} style={{ gap: 4 }}>
                        {b.aml.matches.map((m, i) => (
                          <span key={i} className={s.row} style={{ gap: 6 }}>
                            <Badge tone={m.score >= 0.85 ? "bad" : "warn"}>{m.list}</Badge>
                            <span className={s.muted}>{m.name}</span>
                            <span className={cx(s.num, s.faint)}>{Math.round(m.score * 100)} %</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={s.faint}>{timeAgo(b.createdAt)}</td>
                  <td>
                    <StatusBadge value={b.status} />
                  </td>
                  <td className={s.right}>
                    {b.status === "pending_review" ? (
                      <span className={s.row} style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <GuardedButton allowed={allowed} className={cx(s.btnSm, s.btnPrimary)} onClick={() => setTarget({ b, decision: "approve" })}>
                          Aprobar
                        </GuardedButton>
                        <GuardedButton allowed={allowed} className={cx(s.btnSm, s.btnDanger)} onClick={() => setTarget({ b, decision: "reject" })}>
                          Rechazar
                        </GuardedButton>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        open={!!target}
        title={target?.decision === "approve" ? "Aprobar beneficiario" : "Rechazar beneficiario"}
        description={
          target
            ? target.decision === "approve"
              ? `Se registrará la cuenta de ${target.b.holderName} en Coinsenda y el cliente podrá enviarle dinero.`
              : `${target.b.holderName} quedará rechazado y el cliente no podrá enviarle dinero.`
            : undefined
        }
        confirmLabel={target?.decision === "approve" ? "Aprobar" : "Rechazar"}
        danger={target?.decision === "reject"}
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          if (!target || !api) return;
          await api.decideBeneficiary(target.b.id, target.decision, reason);
          toast(target.decision === "approve" ? "Beneficiario aprobado" : "Beneficiario rechazado");
          void reload(true);
        }}
      />
    </Panel>
  );
}

function Alerts() {
  const { can, api } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const [type, setType] = useState("");
  const { data, error, loading, reload } = useLoad((a) => a.alerts({ status, type }), [status, type]);
  const [target, setTarget] = useState<ComplianceAlert | null>(null);
  const [resolution, setResolution] = useState<AlertResolution>("false_positive");
  const [uiaf, setUiaf] = useState(false);
  useStreamEvent(["compliance.alert"], () => void reload(true));
  const allowed = can("compliance:decide");

  return (
    <Panel
      title="Alertas"
      actions={
        <>
          <select className={s.select} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
            <option value="">Tipo: todos</option>
            {Object.entries(ALERT_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
            <option value="open">Abiertas</option>
            <option value="resolved">Resueltas</option>
            <option value="">Todas</option>
          </select>
        </>
      }
      bodyless
    >
      {error ? (
        <div style={{ padding: 16 }}>
          <ErrorBox message={error} onRetry={() => void reload()} />
        </div>
      ) : loading && !data ? (
        <Skeleton rows={5} />
      ) : !data || data.items.length === 0 ? (
        <Empty>{status === "open" ? "No hay alertas abiertas." : "Sin resultados."}</Empty>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Alerta</th>
                <th>Severidad</th>
                <th>Cliente</th>
                <th>Transacción</th>
                <th>Creada</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{ALERT_TYPE[a.type] ?? a.type}</strong>
                    {a.uiafSuggested ? (
                      <span style={{ marginLeft: 8 }}>
                        <Badge tone="accent">ROS sugerido</Badge>
                      </span>
                    ) : null}
                    <div className={s.muted} style={{ fontSize: 12 }}>
                      {a.description}
                    </div>
                  </td>
                  <td>
                    <StatusBadge value={a.severity} />
                  </td>
                  <td>
                    <Link href={`/admin-portal/customers/?id=${a.customerId}`}>{a.customerName}</Link>
                  </td>
                  <td>
                    {a.transactionId ? (
                      <Link className={s.mono} href={`/admin-portal/transactions/?id=${a.transactionId}`}>
                        {a.transactionId}
                      </Link>
                    ) : (
                      <span className={s.faint}>—</span>
                    )}
                  </td>
                  <td className={s.faint} title={formatDateTime(a.createdAt)}>
                    {timeAgo(a.createdAt)}
                  </td>
                  <td>
                    <StatusBadge value={a.status} />
                    {a.resolution ? (
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {RESOLUTION[a.resolution]} · {a.resolvedBy}
                        {a.reportToUiaf ? " · reportada a UIAF" : ""}
                      </div>
                    ) : null}
                    {a.resolutionNote ? (
                      <div className={s.muted} style={{ fontSize: 12, maxWidth: 280 }} title={a.resolutionNote}>
                        “{a.resolutionNote}”
                      </div>
                    ) : null}
                  </td>
                  <td className={s.right}>
                    {a.status === "open" ? (
                      <GuardedButton
                        allowed={allowed}
                        className={s.btnSm}
                        onClick={() => {
                          setResolution(a.uiafSuggested ? "reported" : "false_positive");
                          setUiaf(a.uiafSuggested);
                          setTarget(a);
                        }}
                      >
                        Resolver
                      </GuardedButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        open={!!target}
        title="Resolver alerta"
        description={target ? `${ALERT_TYPE[target.type]} · ${target.customerName}` : undefined}
        confirmLabel="Resolver"
        reasonLabel="Nota de resolución (queda en el audit log)"
        onClose={() => setTarget(null)}
        onConfirm={async (note) => {
          if (!target || !api) return;
          await api.resolveAlert(target.id, { resolution, note, reportToUiaf: uiaf });
          toast(uiaf ? "Alerta resuelta y marcada para reporte a la UIAF" : "Alerta resuelta");
          void reload(true);
        }}
      >
        <label className={s.field}>
          <span>Resolución</span>
          <select
            className={s.select}
            value={resolution}
            onChange={(e) => {
              const v = e.target.value as AlertResolution;
              setResolution(v);
              if (v === "reported") setUiaf(true);
            }}
          >
            {Object.entries(RESOLUTION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {resolution === "frozen" ? <div className={s.hint}>El cliente quedará congelado al resolver.</div> : null}
        {target?.uiafSuggested ? (
          <div className={s.hint}>El motor de reglas sugiere reportar esta operación a la UIAF (ROS).</div>
        ) : null}
        <label className={s.check}>
          <input type="checkbox" checked={uiaf} onChange={(e) => setUiaf(e.target.checked)} id="alert-uiaf" />
          Reportar a la UIAF (Reporte de Operación Sospechosa)
        </label>
      </ReasonDialog>
    </Panel>
  );
}
