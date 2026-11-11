"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { LoanConfigDto, LoanDto, LoanRateTierDto, PromissoryNoteDto } from "@/lib/admin/types";
import { RequirePerm } from "../AdminShell";
import {
  css as s,
  cx,
  errorMessage,
  ErrorBox,
  GuardedButton,
  Kpi,
  PageHead,
  Panel,
  ReasonDialog,
  Skeleton,
  StatusBadge,
  useToast,
} from "../ui";

function formatCopMinor(minor: string | number | bigint): string {
  const n = typeof minor === "bigint" ? Number(minor) : Number(minor || 0);
  return `$${(n / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })} COP`;
}

export function LoansAdminView() {
  return (
    <RequirePerm perm="treasury:read">
      <LoansAdmin />
    </RequirePerm>
  );
}

function LoansAdmin() {
  const { data: config, setData: setConfig, error, loading, reload } = useLoad((a) => a.loansConfig(), []);

  if (error && !config) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !config) {
    return (
      <Panel title="Préstamos y Pagarés">
        <Skeleton rows={8} />
      </Panel>
    );
  }
  if (!config) return null;

  return <LoansAdminInner key={config.updatedAt} initialConfig={config} onUpdate={setConfig} />;
}

function LoansAdminInner({
  initialConfig,
  onUpdate,
}: {
  initialConfig: LoanConfigDto;
  onUpdate: (cfg: LoanConfigDto) => void;
}) {
  const { can, api } = useSession();
  const toast = useToast();
  const poolLoad = useLoad((a) => a.loansPool(), []);
  const loansLoad = useLoad((a) => a.loans(), []);

  const canWrite = can("treasury:write");

  // Filtros
  const [statusTab, setStatusTab] = useState<
    "all" | "pending_review" | "approved_active" | "overdue" | "paid" | "rejected"
  >("all");
  const [search, setSearch] = useState("");

  // Movimientos del Bolsillo de Préstamos
  const [poolModal, setPoolModal] = useState<"fund" | "withdraw" | null>(null);
  const [poolAmountCop, setPoolAmountCop] = useState("");

  // Aprobar / Rechazar solicitud
  const [approveTarget, setApproveTarget] = useState<LoanDto | null>(null);
  const [rejectTarget, setRejectTarget] = useState<LoanDto | null>(null);

  // Visor de Pagaré Electrónico + Carta de Instrucciones
  const [inspectLoanId, setInspectLoanId] = useState<string | null>(null);
  const [noteDetail, setNoteDetail] = useState<PromissoryNoteDto | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteDialogRef = useRef<HTMLDialogElement>(null);

  // Configuración de tasas y tope de usura SFC
  const [enabledForm, setEnabledForm] = useState(initialConfig.enabled);
  const [usuryForm, setUsuryForm] = useState(initialConfig.usuryCeilingEaPercent);
  const [moratoryForm, setMoratoryForm] = useState(initialConfig.moratoryRateEaPercent);
  const [minCopForm, setMinCopForm] = useState(String(Math.round(Number(initialConfig.minAmountMinor) / 100)));
  const [maxCopForm, setMaxCopForm] = useState(String(Math.round(Number(initialConfig.maxAmountMinor) / 100)));
  const [ratesForm, setRatesForm] = useState<LoanRateTierDto[]>(() =>
    initialConfig.rates.map((r) => ({ ...r })),
  );
  const [saveConfigOpen, setSaveConfigOpen] = useState(false);

  const loans = useMemo(() => loansLoad.data?.items ?? [], [loansLoad.data]);
  const pool = poolLoad.data;

  const filteredLoans = useMemo(() => {
    const q = search.trim().toLowerCase();
    return loans.filter((l) => {
      if (statusTab !== "all" && l.status !== statusTab) return false;
      if (!q) return true;
      const hay = `${l.debtorFullName} ${l.debtorDocumentNumber} ${l.debtorEmail} ${l.debtorPhone} ${l.promissoryNoteNumber} ${l.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [loans, statusTab, search]);

  useEffect(() => {
    const d = noteDialogRef.current;
    if (!d) return;
    if (inspectLoanId && !d.open) d.showModal();
    else if (!inspectLoanId && d.open) d.close();
  }, [inspectLoanId]);

  if (!api) return null;

  const reloadAll = () => {
    void poolLoad.reload();
    void loansLoad.reload();
  };

  const openPromissoryNote = async (loanId: string) => {
    setInspectLoanId(loanId);
    setNoteDetail(null);
    setNoteError(null);
    setNoteLoading(true);
    try {
      const note = await api.loanPromissoryNote(loanId);
      setNoteDetail(note);
    } catch (ex) {
      setNoteError(errorMessage(ex, "No se pudo cargar el Pagaré electrónico."));
    } finally {
      setNoteLoading(false);
    }
  };

  const printPromissoryNote = (note: PromissoryNoteDto) => {
    const w = window.open("", "_blank", "noopener,noreferrer,width=920,height=860");
    if (!w) {
      toast("Permite ventanas emergentes para imprimir o guardar el PDF del Pagaré.", "bad");
      return;
    }
    w.document.open();
    w.document.write(note.printableHtml);
    w.document.close();
    w.focus();
    setTimeout(() => {
      try {
        w.print();
      } catch {
        /* usuario puede imprimir manualmente */
      }
    }, 350);
  };

  const parsedPoolMinor = Math.round((Number(poolAmountCop.replace(/[^0-9.]/g, "")) || 0) * 100);

  const submitPoolMovement = async (reason: string) => {
    if (!poolModal || parsedPoolMinor <= 0) return;
    const minorStr = String(parsedPoolMinor);
    if (poolModal === "fund") {
      await api.fundLoansPool(minorStr, reason);
      toast("Bolsillo de Préstamos fondeado exitosamente.", "ok");
    } else {
      await api.withdrawLoansPool(minorStr, reason);
      toast("Capital retirado del Bolsillo de Préstamos.", "ok");
    }
    setPoolAmountCop("");
    setPoolModal(null);
    reloadAll();
  };

  const submitApprove = async (reason: string) => {
    if (!approveTarget) return;
    await api.approveLoan(approveTarget.id, reason);
    toast(
      `Crédito aprobado y ${formatCopMinor(approveTarget.principalMinor)} desembolsados automáticamente a ${approveTarget.debtorFullName}.`,
      "ok",
    );
    setApproveTarget(null);
    setInspectLoanId(null);
    reloadAll();
  };

  const submitReject = async (reason: string) => {
    if (!rejectTarget) return;
    await api.rejectLoan(rejectTarget.id, reason);
    toast("Solicitud rechazada y Pagaré anulado sin desembolso.", "ok");
    setRejectTarget(null);
    setInspectLoanId(null);
    reloadAll();
  };

  const handleRateChange = (termDays: number, field: "rateEaPercent" | "enabled", value: number | boolean) => {
    setRatesForm((prev) => prev.map((r) => (r.termDays === termDays ? { ...r, [field]: value } : r)));
  };

  const submitConfig = async (reason: string) => {
    const minMinor = String(Math.max(100_000, Math.round((Number(minCopForm) || 0) * 100)));
    const maxMinor = String(Math.max(Number(minMinor), Math.round((Number(maxCopForm) || 0) * 100)));
    const updated = await api.updateLoansConfig(
      {
        enabled: enabledForm,
        rates: ratesForm,
        usuryCeilingEaPercent: usuryForm,
        moratoryRateEaPercent: Math.min(moratoryForm, usuryForm),
        minAmountMinor: minMinor,
        maxAmountMinor: maxMinor,
      },
      reason,
    );
    onUpdate(updated);
    toast("Parámetros legales y tasas de préstamos actualizados.", "ok");
    setSaveConfigOpen(false);
  };

  const pendingAppsCount = pool?.pendingApplicationsCount ?? 0;

  return (
    <div className={s.stack}>
      <PageHead
        title="Préstamos y Pagarés"
        sub="Bolsillo de Préstamos con recursos propios, evaluación de solicitudes (30–360 días) y custodia de Pagarés Electrónicos con mérito ejecutivo (Arts. 621, 622 y 709 C.Co. · Ley 527/1999)."
        actions={
          <div className={s.row} style={{ flexWrap: "wrap", gap: 8 }}>
            <GuardedButton
              allowed={canWrite}
              className={cx(s.btn)}
              onClick={() => {
                setPoolAmountCop("");
                setPoolModal("withdraw");
              }}
            >
              ➖ Retirar del bolsillo
            </GuardedButton>
            <GuardedButton
              allowed={canWrite}
              className={cx(s.btn, s.btnPrimary)}
              onClick={() => {
                setPoolAmountCop("");
                setPoolModal("fund");
              }}
            >
              ➕ Fondear bolsillo de préstamos
            </GuardedButton>
          </div>
        }
      />

      {/* Aviso de solicitudes pendientes por aprobar */}
      {pendingAppsCount > 0 ? (
        <div
          style={{
            background: "rgba(76, 199, 154, 0.12)",
            border: "1px solid rgba(76, 199, 154, 0.4)",
            borderRadius: 14,
            padding: "14px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <strong>📋 Tienes {pendingAppsCount} solicitud(es) de crédito con Pagaré firmado esperando revisión</strong>
            <div className={s.faint} style={{ fontSize: 13 }}>
              Capital total solicitado: <strong>{pool ? formatCopMinor(pool.pendingApplicationsPrincipalMinor) : "—"}</strong> ·
              Disponible en Bolsillo de Préstamos: <strong>{pool ? formatCopMinor(pool.availablePoolMinor) : "—"}</strong>
            </div>
          </div>
          <button
            type="button"
            className={cx(s.btn, s.btnSm, s.btnPrimary)}
            onClick={() => setStatusTab("pending_review")}
          >
            Ver pendientes ({pendingAppsCount})
          </button>
        </div>
      ) : null}

      {/* KPIs del Bolsillo de Préstamos y Cartera */}
      <div className={s.grid4}>
        <Kpi
          label="Bolsillo de Préstamos (Disponible)"
          value={pool ? formatCopMinor(pool.availablePoolMinor) : "—"}
          sub="Plata disponible para desembolsar créditos"
        />
        <Kpi
          label="Cartera Activa por Cobrar"
          value={pool ? formatCopMinor(pool.activePortfolioRemainingMinor) : "—"}
          sub={
            pool
              ? `${pool.activeLoansCount} activos · Capital: ${formatCopMinor(pool.activePortfolioPrincipalMinor)}`
              : "Capital + intereses vigentes"
          }
        />
        <Kpi
          label="Intereses Recaudados / Proyectados"
          value={pool ? formatCopMinor(pool.collectedInterestMinor) : "—"}
          sub={pool ? `Por devengar: ${formatCopMinor(pool.pendingExpectedInterestMinor)}` : ""}
        />
        <Kpi
          label="Cartera en Mora / Pagados"
          value={pool ? `${pool.overdueLoansCount} en mora` : "—"}
          sub={
            pool
              ? `Mora: ${formatCopMinor(pool.overdueRemainingMinor)} · ${pool.paidLoansCount} pagados`
              : ""
          }
        />
      </div>

      {/* Solicitudes y Cartera de Préstamos */}
      <Panel
        title={`Solicitudes y Cartera de Créditos (${filteredLoans.length})`}
        actions={
          <div className={s.row} style={{ flexWrap: "wrap", gap: 8 }}>
            <input
              type="search"
              className={s.input}
              placeholder="Buscar deudor, CC, Pagaré…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 220 }}
            />
            {(
              [
                ["all", "Todos"],
                ["pending_review", `En revisión (${pendingAppsCount})`],
                ["approved_active", "Activos"],
                ["overdue", "En mora"],
                ["paid", "Pagados"],
                ["rejected", "Rechazados"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={cx(s.btn, s.btnSm, statusTab === key && s.btnPrimary)}
                onClick={() => setStatusTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {filteredLoans.length === 0 ? (
          <p style={{ padding: 20, opacity: 0.7, textAlign: "center" }}>
            No hay créditos registrados en esta bandeja.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Deudor / Identificación</th>
                  <th>Pagaré Nº</th>
                  <th>Capital</th>
                  <th>Plazo · Tasa</th>
                  <th>Total / Saldo</th>
                  <th>Estado</th>
                  <th>Vencimiento</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredLoans.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{l.debtorFullName}</div>
                      <div style={{ fontSize: 12 }}>
                        <strong>
                          {l.debtorDocumentType} {l.debtorDocumentNumber}
                        </strong>{" "}
                        · {l.debtorCity}
                      </div>
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {l.debtorPhone} · {l.debtorEmail}
                      </div>
                      {l.purpose ? (
                        <div className={s.faint} style={{ fontSize: 11 }}>
                          Destino: {l.purpose}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className={s.mono} style={{ fontWeight: 700 }}>
                        {l.promissoryNoteNumber}
                      </span>
                      <div className={s.faint} style={{ fontSize: 11 }}>
                        Radicado: {formatDateTime(l.requestedAt)}
                      </div>
                    </td>
                    <td className={s.num}>
                      <strong>{formatCopMinor(l.principalMinor)}</strong>
                    </td>
                    <td className={s.num}>
                      <div>
                        <strong>{l.termDays} días</strong>
                      </div>
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {l.interestRateEa}% E.A. ({l.nominalMonthlyPercent}% N.M.V.)
                      </div>
                    </td>
                    <td className={s.num}>
                      <div>Total: {formatCopMinor(l.totalDueMinor)}</div>
                      {l.status === "approved_active" || l.status === "overdue" ? (
                        <div style={{ fontSize: 12, fontWeight: 600, color: l.status === "overdue" ? "#ff7b72" : "#4cc79a" }}>
                          Saldo: {formatCopMinor(l.remainingMinor)}
                        </div>
                      ) : l.status === "paid" ? (
                        <div className={s.faint} style={{ fontSize: 12 }}>
                          Abonado: {formatCopMinor(l.paidMinor)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge value={l.status} />
                    </td>
                    <td>
                      {l.dueAt ? (
                        <>
                          <div style={{ fontWeight: 600 }}>{formatDateTime(l.dueAt)}</div>
                          {l.daysRemaining !== null && (l.status === "approved_active" || l.status === "overdue") ? (
                            <div className={s.faint} style={{ fontSize: 12 }}>
                              {l.daysRemaining > 0 ? `${l.daysRemaining} día(s) restantes` : "Plazo cumplido"}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className={s.faint}>Se fija al desembolsar</span>
                      )}
                    </td>
                    <td>
                      <div className={s.row} style={{ flexWrap: "wrap", gap: 6 }}>
                        <button
                          type="button"
                          className={cx(s.btn, s.btnSm)}
                          onClick={() => void openPromissoryNote(l.id)}
                        >
                          📄 Ver Pagaré
                        </button>
                        {l.status === "pending_review" ? (
                          <>
                            <GuardedButton
                              allowed={canWrite}
                              className={cx(s.btn, s.btnSm, s.btnPrimary)}
                              onClick={() => setApproveTarget(l)}
                            >
                              ✅ Aprobar
                            </GuardedButton>
                            <GuardedButton
                              allowed={canWrite}
                              className={cx(s.btn, s.btnSm, s.btnDanger)}
                              onClick={() => setRejectTarget(l)}
                            >
                              ✕ Rechazar
                            </GuardedButton>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Parámetros Legales y Tasas de Préstamos (30 / 60 / 90 / 180 / 360 días) */}
      <Panel
        title="Tasas de Crédito (30 · 60 · 90 · 180 · 360 días) y Control Legal de Usura SFC"
        actions={
          canWrite ? (
            <button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => setSaveConfigOpen(true)}>
              Guardar parámetros de crédito
            </button>
          ) : undefined
        }
      >
        <div className={s.stack} style={{ gap: 16 }}>
          <div
            style={{
              background: "rgba(173, 203, 200, 0.08)",
              border: "1px solid rgba(173, 203, 200, 0.22)",
              borderRadius: 12,
              padding: "12px 16px",
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            ⚖️ <strong>Blindaje Normativo Colombiano Activo:</strong> Mutuo comercial con recursos propios de{" "}
            <strong>{initialConfig.creditorLegalName} (NIT {initialConfig.creditorNit})</strong> · Pagaré Electrónico a la Orden
            + Carta de Instrucciones (Arts. 621, 622 y 709 C.Co. · Art. 422 CGP) · Firma electrónica ECDSA P-256 en Secure
            Enclave (Ley 527 de 1999 y Decreto 2364 de 2012) · Control automático contra usura (Art. 884 C.Co. y Art. 305 C.P.) ·
            Pago anticipado sin penalidad (Ley 1480 de 2011 Art. 45).
          </div>

          <div className={s.grid4}>
            <label className={s.field}>
              <span>Tope Legal Usura SFC (% E.A.)</span>
              <input
                type="number"
                step="0.01"
                min="1"
                max="60"
                className={s.input}
                disabled={!canWrite}
                value={usuryForm}
                onChange={(e) => setUsuryForm(Number.parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className={s.field}>
              <span>Tasa Moratoria Máx. (% E.A.)</span>
              <input
                type="number"
                step="0.01"
                min="1"
                max={usuryForm}
                className={s.input}
                disabled={!canWrite}
                value={moratoryForm}
                onChange={(e) => setMoratoryForm(Number.parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className={s.field}>
              <span>Monto Mínimo (COP)</span>
              <input
                type="number"
                step="10000"
                className={s.input}
                disabled={!canWrite}
                value={minCopForm}
                onChange={(e) => setMinCopForm(e.target.value)}
              />
            </label>
            <label className={s.field}>
              <span>Monto Máximo (COP)</span>
              <input
                type="number"
                step="50000"
                className={s.input}
                disabled={!canWrite}
                value={maxCopForm}
                onChange={(e) => setMaxCopForm(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={enabledForm}
              disabled={!canWrite}
              onChange={(e) => setEnabledForm(e.target.checked)}
            />
            <span>Permitir nuevas solicitudes de crédito desde la app móvil CuyPay</span>
          </label>

          <table className={s.table}>
            <thead>
              <tr>
                <th>Plazo permitido</th>
                <th>Tasa Remuneratoria (% E.A.)</th>
                <th>Margen bajo usura</th>
                <th>Estado</th>
                <th>Habilitar</th>
              </tr>
            </thead>
            <tbody>
              {ratesForm.map((tier) => {
                const overUsury = tier.rateEaPercent > usuryForm;
                return (
                  <tr key={tier.termDays}>
                    <td>
                      <strong>{tier.termDays} días</strong>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number"
                          step="0.1"
                          min="1"
                          max={usuryForm}
                          value={tier.rateEaPercent}
                          disabled={!canWrite}
                          onChange={(e) =>
                            handleRateChange(tier.termDays, "rateEaPercent", Number.parseFloat(e.target.value) || 0)
                          }
                          className={s.input}
                          style={{ width: 96, borderColor: overUsury ? "#ff7b72" : undefined }}
                        />
                        <span>% E.A.</span>
                      </div>
                    </td>
                    <td>
                      {overUsury ? (
                        <span style={{ color: "#ff7b72", fontWeight: 600 }}>Supera tope SFC ({usuryForm}%)</span>
                      ) : (
                        <span className={s.faint}>{(usuryForm - tier.rateEaPercent).toFixed(2)}% bajo tope</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge value={tier.enabled ? "active" : "disabled"} />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={tier.enabled}
                        disabled={!canWrite}
                        onChange={(e) => handleRateChange(tier.termDays, "enabled", e.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Modal Visor de Pagaré Electrónico + Carta de Instrucciones */}
      <dialog
        ref={noteDialogRef}
        className={s.dialog}
        style={{ maxWidth: 820, width: "95vw" }}
        onClose={() => setInspectLoanId(null)}
      >
        {inspectLoanId ? (
          <div>
            <div className={s.dialogHead}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h2>
                    {noteDetail ? `Pagaré Electrónico Nº ${noteDetail.number}` : "Cargando Pagaré Electrónico…"}
                  </h2>
                  <p>
                    Título valor a la orden de {initialConfig.creditorLegalName} (NIT {initialConfig.creditorNit}) + Carta de Instrucciones (Art. 622 C.Co.)
                  </p>
                </div>
                {noteDetail ? <StatusBadge value={noteDetail.status} /> : null}
              </div>
            </div>

            <div className={s.dialogBody} style={{ maxHeight: "68vh", overflowY: "auto" }}>
              {noteLoading ? <Skeleton rows={6} /> : null}
              {noteError ? <ErrorBox message={noteError} /> : null}
              {noteDetail ? (
                <div className={s.stack} style={{ gap: 14 }}>
                  <div
                    style={{
                      background: noteDetail.integrityVerified ? "rgba(76, 199, 154, 0.1)" : "rgba(255, 123, 114, 0.14)",
                      border: `1px solid ${noteDetail.integrityVerified ? "rgba(76, 199, 154, 0.4)" : "rgba(255, 123, 114, 0.45)"}`,
                      borderRadius: 10,
                      padding: "10px 14px",
                      fontSize: 12.5,
                    }}
                  >
                    <strong>
                      {noteDetail.integrityVerified
                        ? "🔐 Integridad Criptográfica SHA-256 & ECDSA P-256 Verificada"
                        : "⚠️ Alerta de integridad documental"}
                    </strong>
                    <div className={s.mono} style={{ fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
                      SHA-256 Documento: {noteDetail.documentSha256}
                      <br />
                      Dispositivo Secure Enclave: {noteDetail.signature.deviceName} ({noteDetail.signature.deviceId}) · Firmado:{" "}
                      {formatDateTime(noteDetail.signature.signedAt)} · IP: {noteDetail.signature.signerIp}
                      <br />
                      Firma ECDSA DER (Base64): {noteDetail.signature.ecdsaSignatureBase64}
                    </div>
                  </div>

                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontFamily: "Georgia, 'Times New Roman', serif",
                      fontSize: 13,
                      lineHeight: 1.6,
                      background: "rgba(0,0,0,0.22)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 10,
                      padding: 16,
                      margin: 0,
                    }}
                  >
                    {noteDetail.documentMarkdown}
                  </pre>
                </div>
              ) : null}
            </div>

            <div className={s.dialogFoot} style={{ flexWrap: "wrap", gap: 8 }}>
              {noteDetail ? (
                <button
                  type="button"
                  className={cx(s.btn, s.btnPrimary)}
                  onClick={() => printPromissoryNote(noteDetail)}
                >
                  🖨️ Imprimir / Guardar PDF Ejecutivo
                </button>
              ) : null}
              {noteDetail && noteDetail.status === "signed_custody" ? (
                <>
                  <GuardedButton
                    allowed={canWrite}
                    className={cx(s.btn, s.btnPrimary)}
                    onClick={() => {
                      const target = loans.find((x) => x.id === noteDetail.loanId) ?? null;
                      setApproveTarget(target);
                    }}
                  >
                    ✅ Aprobar y desembolsar
                  </GuardedButton>
                  <GuardedButton
                    allowed={canWrite}
                    className={cx(s.btn, s.btnDanger)}
                    onClick={() => {
                      const target = loans.find((x) => x.id === noteDetail.loanId) ?? null;
                      setRejectTarget(target);
                    }}
                  >
                    ✕ Rechazar solicitud
                  </GuardedButton>
                </>
              ) : null}
              <button type="button" className={s.btn} onClick={() => setInspectLoanId(null)}>
                Cerrar
              </button>
            </div>
          </div>
        ) : null}
      </dialog>

      {/* Diálogo Fondear / Retirar Bolsillo de Préstamos */}
      <ReasonDialog
        open={poolModal !== null}
        title={
          poolModal === "fund"
            ? "Fondear Bolsillo de Préstamos"
            : "Retirar capital del Bolsillo de Préstamos"
        }
        description={
          poolModal === "fund"
            ? "Asigna capital propio disponible en el Bolsillo de Préstamos. Al aprobar cualquier solicitud de crédito, el sistema debitará automáticamente este bolsillo y acreditará el dinero al cliente."
            : "Retira liquidez libre del Bolsillo de Préstamos hacia capital de tesorería."
        }
        confirmLabel={poolModal === "fund" ? "Fondear bolsillo" : "Retirar capital"}
        canConfirm={parsedPoolMinor > 0}
        onClose={() => setPoolModal(null)}
        onConfirm={submitPoolMovement}
      >
        <label className={s.field} style={{ marginBottom: 12 }}>
          <span>Monto en Pesos Colombianos (COP)</span>
          <input
            type="number"
            min="10000"
            step="10000"
            className={s.input}
            placeholder="Ej: 5000000"
            value={poolAmountCop}
            onChange={(e) => setPoolAmountCop(e.target.value)}
          />
          {parsedPoolMinor > 0 ? (
            <small className={s.faint}>Movimiento contable: {formatCopMinor(parsedPoolMinor)}</small>
          ) : null}
        </label>
      </ReasonDialog>

      {/* Diálogo Aprobar y Desembolsar */}
      <ReasonDialog
        open={approveTarget !== null}
        title="Aprobar solicitud y desembolsar préstamo"
        description={
          approveTarget
            ? `Se debitarán automáticamente ${formatCopMinor(approveTarget.principalMinor)} del Bolsillo de Préstamos y se acreditarán de inmediato en la billetera CuyPay de ${approveTarget.debtorFullName} (${approveTarget.debtorDocumentType} ${approveTarget.debtorDocumentNumber}). El Pagaré ${approveTarget.promissoryNoteNumber} pasará a estado VIGENTE CON MÉRITO EJECUTIVO a ${approveTarget.termDays} días.`
            : ""
        }
        confirmLabel="Aprobar y desembolsar ahora"
        onClose={() => setApproveTarget(null)}
        onConfirm={submitApprove}
      />

      {/* Diálogo Rechazar solicitud */}
      <ReasonDialog
        open={rejectTarget !== null}
        danger
        title="Rechazar solicitud de crédito"
        description={
          rejectTarget
            ? `La solicitud de ${rejectTarget.debtorFullName} por ${formatCopMinor(rejectTarget.principalMinor)} será rechazada sin desembolso y el Pagaré ${rejectTarget.promissoryNoteNumber} quedará anulado en custodia.`
            : ""
        }
        confirmLabel="Rechazar solicitud"
        onClose={() => setRejectTarget(null)}
        onConfirm={submitReject}
      />

      {/* Diálogo Guardar Configuración */}
      <ReasonDialog
        open={saveConfigOpen}
        title="Confirmar actualización de tasas y parámetros legales"
        description="Las nuevas tasas y límites se aplicarán a las nuevas solicitudes de crédito. Los créditos ya desembolsados conservan las condiciones pactadas en su Pagaré firmado."
        confirmLabel="Guardar configuración"
        onClose={() => setSaveConfigOpen(false)}
        onConfirm={submitConfig}
      />
    </div>
  );
}
