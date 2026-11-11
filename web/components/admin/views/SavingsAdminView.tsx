"use client";

import { useMemo, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { SavingsBlockDto, SavingsConfigDto, SavingsRateTierDto } from "@/lib/admin/types";
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

function formatCountdown(hoursRemaining?: number, status?: string): string {
  if (status === "completed") return "Liquidado y pagado";
  if (status === "canceled") return "Cancelado";
  if (hoursRemaining === undefined) return "—";
  if (hoursRemaining <= 0) return "Listo para reintegro inmediato";
  if (hoursRemaining < 72) return `Faltan ${hoursRemaining.toFixed(1)} h`;
  const days = Math.floor(hoursRemaining / 24);
  const remH = Math.round(hoursRemaining % 24);
  return `Faltan ${days}d ${remH}h`;
}

export function SavingsAdminView() {
  return (
    <RequirePerm perm="treasury:read">
      <SavingsAdmin />
    </RequirePerm>
  );
}

function SavingsAdmin() {
  const { data: config, setData: setConfig, error, loading, reload } = useLoad((a) => a.savingsConfig(), []);

  if (error && !config) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !config) {
    return (
      <Panel title="Bolsillo de Ahorros">
        <Skeleton rows={8} />
      </Panel>
    );
  }
  if (!config) return null;

  return <SavingsAdminInner key={config.updatedAt} initialConfig={config} onUpdate={setConfig} />;
}

interface SavingsAdminInnerProps {
  initialConfig: SavingsConfigDto;
  onUpdate: (cfg: SavingsConfigDto) => void;
}

function SavingsAdminInner({ initialConfig, onUpdate }: SavingsAdminInnerProps) {
  const { can, api } = useSession();
  const toast = useToast();
  const poolLoad = useLoad((a) => a.savingsPool(), []);
  const blocksLoad = useLoad((a) => a.savingsBlocks(), []);
  const alertsLoad = useLoad((a) => a.treasurySavingsAlerts(), []);

  const [ratesForm, setRatesForm] = useState<SavingsRateTierDto[]>(() =>
    initialConfig.rates.map((r: SavingsRateTierDto) => ({ ...r })),
  );
  const [contractTerms, setContractTerms] = useState(initialConfig.contractTerms);
  const [saveRatesOpen, setSaveRatesOpen] = useState(false);
  const [saveTermsOpen, setSaveTermsOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Movimientos del Bolsillo Recaudo de Intereses / Ahorros
  const [poolAction, setPoolAction] = useState<"withdraw" | "deposit" | null>(null);
  const [poolAmountCop, setPoolAmountCop] = useState("");

  // Bloqueo 72h individual o masivo
  const [lockTargetBlock, setLockTargetBlock] = useState<SavingsBlockDto | null>(null);
  const [lockBatchOpen, setLockBatchOpen] = useState(false);

  // Filtros de tabla
  const [filterTab, setFilterTab] = useState<"all" | "active" | "maturing72h" | "completed">("all");
  const [search, setSearch] = useState("");

  const canWrite = can("treasury:write");

  const blocks: SavingsBlockDto[] = useMemo(() => blocksLoad.data?.items ?? [], [blocksLoad.data]);
  const pool = poolLoad.data;
  const alerts = alertsLoad.data;

  const filteredBlocks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return blocks.filter((b) => {
      const isAct = b.status === "active" || b.status === "maturing_soon";
      const is72h = isAct && (b.hoursRemaining ?? 999) <= 72;
      if (filterTab === "active" && !isAct) return false;
      if (filterTab === "maturing72h" && !is72h) return false;
      if (filterTab === "completed" && b.status !== "completed") return false;
      if (!q) return true;
      const hay = `${b.customerName ?? ""} ${b.customerEmail ?? ""} ${b.customerPhone ?? ""} ${b.id} ${b.userId}`.toLowerCase();
      return hay.includes(q);
    });
  }, [blocks, filterTab, search]);

  if (!api) return null;

  const reloadAll = () => {
    void poolLoad.reload();
    void blocksLoad.reload();
    void alertsLoad.reload();
  };

  const handleRateChange = (termDays: number, field: "ratePercent" | "enabled", value: number | boolean) => {
    setRatesForm((prev) => prev.map((r) => (r.termDays === termDays ? { ...r, [field]: value } : r)));
  };

  const submitRates = async (reason: string) => {
    try {
      const updated = await api.updateSavingsConfig(ratesForm, undefined, reason);
      onUpdate(updated);
      toast("Tasas del Bolsillo de Ahorro actualizadas.", "ok");
    } catch (ex) {
      toast(errorMessage(ex, "Error al actualizar las tasas."), "bad");
    }
  };

  const submitContract = async (reason: string) => {
    try {
      const updated = await api.updateSavingsConfig(ratesForm, contractTerms, reason);
      onUpdate(updated);
      toast("Contrato virtual actualizado.", "ok");
    } catch (ex) {
      toast(errorMessage(ex, "Error al actualizar el contrato."), "bad");
    }
  };

  const runMaturitySettlement = async () => {
    setIsProcessing(true);
    try {
      const res = await api.processSavingsMaturities();
      toast(
        res.completedCount > 0
          ? `Reintegro ejecutado: ${res.completedCount} bolsillo(s) acreditados en la cuenta del cliente.`
          : "No hay bolsillos con fecha/hora cumplida en este instante (el motor automático vigila cada pocos segundos).",
        "ok",
      );
      reloadAll();
    } catch (ex) {
      toast(errorMessage(ex, "Error al procesar liquidación."), "bad");
    } finally {
      setIsProcessing(false);
    }
  };

  const parsedPoolMinor = Math.round((Number(poolAmountCop.replace(/[^0-9.]/g, "")) || 0) * 100);

  const submitPoolMovement = async (reason: string) => {
    if (!poolAction || parsedPoolMinor <= 0) return;
    const minorStr = String(parsedPoolMinor);
    if (poolAction === "withdraw") {
      await api.withdrawSavingsPool(minorStr, reason);
      toast("Capital retirado del Bolsillo Recaudo para inversión.", "ok");
    } else {
      await api.depositSavingsPool(minorStr, reason);
      toast("Capital y rendimientos abonados al Bolsillo Recaudo.", "ok");
    }
    setPoolAmountCop("");
    setPoolAction(null);
    reloadAll();
  };

  const submitSingleEscrowLock = async (reason: string) => {
    if (!lockTargetBlock) return;
    await api.fundSavingsBlockEscrow(lockTargetBlock.id, reason);
    toast("Capital + intereses colocados y bloqueados para reintegro exacto al vencimiento.", "ok");
    setLockTargetBlock(null);
    reloadAll();
  };

  const submitBatch72hLock = async (reason: string) => {
    const res = await api.fundAllMaturing72h(reason);
    toast(
      res.fundedCount > 0
        ? `${res.fundedCount} bolsillo(s) bloqueados en Reserva 72h (${formatCopMinor(res.totalLockedMinor)}).`
        : "Todos los bolsillos <72h ya tienen reserva bloqueada.",
      "ok",
    );
    setLockBatchOpen(false);
    reloadAll();
  };

  const unfunded72hCount = pool?.maturing72hUnfundedCount ?? alerts?.unfundedMaturingCount ?? 0;
  const unfunded72hMinor = pool?.maturing72hUnfundedMinor ?? alerts?.unfundedMaturing72hMinor ?? "0";

  return (
    <div className={s.stack}>
      <PageHead
        title="Bolsillo de Ahorros"
        sub="Bolsillo Recaudo de Intereses (30 · 60 · 90 · 180 · 360 días), bloqueo 72h previo y reintegro automático en la hora exacta."
        actions={
          <div className={s.row} style={{ flexWrap: "wrap", gap: 8 }}>
            <GuardedButton
              allowed={canWrite}
              className={cx(s.btn)}
              onClick={() => {
                setPoolAmountCop("");
                setPoolAction("deposit");
              }}
            >
              📥 Abonar capital / rendimientos
            </GuardedButton>
            <GuardedButton
              allowed={canWrite}
              className={cx(s.btn)}
              onClick={() => {
                setPoolAmountCop("");
                setPoolAction("withdraw");
              }}
            >
              📤 Retirar para inversión
            </GuardedButton>
            <GuardedButton
              allowed={canWrite}
              className={cx(s.btn, s.btnPrimary)}
              onClick={runMaturitySettlement}
              disabled={isProcessing}
            >
              {isProcessing ? "Verificando…" : "⚡ Procesar vencidos ahora"}
            </GuardedButton>
          </div>
        }
      />

      {/* Alerta operativa 72 horas */}
      {unfunded72hCount > 0 ? (
        <div
          style={{
            background: "rgba(224, 132, 36, 0.14)",
            border: "1px solid rgba(224, 132, 36, 0.45)",
            borderRadius: 14,
            padding: "16px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 14,
          }}
        >
          <div style={{ maxWidth: 760 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 20 }}>⏰</span>
              <strong style={{ fontSize: 15 }}>
                Ventana de 72 Horas: {unfunded72hCount} bolsillo(s) próximos a vencer requieren bloqueo de reintegro
              </strong>
            </div>
            <p style={{ margin: 0, fontSize: 13.5, opacity: 0.9 }}>
              Coloca y bloquea <strong>{formatCopMinor(unfunded72hMinor)}</strong> (capital + intereses) en la Reserva 72h.
              Al cumplirse el día y la hora exacta de cada cliente, el sistema acreditará automáticamente el saldo en su billetera.
            </p>
          </div>
          <GuardedButton
            allowed={canWrite}
            className={cx(s.btn, s.btnPrimary)}
            onClick={() => setLockBatchOpen(true)}
          >
            🔒 Colocar y bloquear todos (&lt;72h)
          </GuardedButton>
        </div>
      ) : null}

      {/* KPIs del Bolsillo Recaudo de Intereses y Reserva 72h */}
      <div className={s.grid4}>
        <Kpi
          label="Bolsillo Recaudo de Ahorros"
          value={pool ? formatCopMinor(pool.collectionPoolBalanceMinor) : "—"}
          sub={
            pool && Number(pool.deployedExternallyMinor) > 0
              ? `Movilizado en inversión: ${formatCopMinor(pool.deployedExternallyMinor)}`
              : "Saldo disponible en nuestro bolsillo de recaudo"
          }
        />
        <Kpi
          label="Reserva Bloqueada 72h"
          value={pool ? formatCopMinor(pool.escrowLockedBalanceMinor) : "—"}
          sub="Bloqueado listo para pago automático en hora exacta"
        />
        <Kpi
          label="Capital + Intereses Activos"
          value={pool ? formatCopMinor(pool.totalActivePayoutMinor) : "—"}
          sub={
            pool
              ? `Capital: ${formatCopMinor(pool.totalActivePrincipalMinor)} · Interés: ${formatCopMinor(pool.totalPendingYieldMinor)}`
              : "Obligaciones vigentes"
          }
        />
        <Kpi
          label="Bolsillos Vigentes / Pagados"
          value={pool ? `${pool.activeBlocksCount} activos` : "—"}
          sub={pool ? `${pool.completedBlocksCount} reintegrados históricamente` : ""}
        />
      </div>

      {/* Tabla principal de clientes ahorrando */}
      <Panel
        title={`Clientes en Bolsillo de Ahorros (${filteredBlocks.length})`}
        actions={
          <div className={s.row} style={{ flexWrap: "wrap", gap: 8 }}>
            <input
              type="search"
              className={s.input}
              placeholder="Buscar cliente, celular o correo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 230 }}
            />
            {(
              [
                ["all", "Todos"],
                ["active", "Activos"],
                ["maturing72h", `Vencen <72h (${pool?.maturing72hTotalCount ?? 0})`],
                ["completed", "Pagados"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={cx(s.btn, s.btnSm, filterTab === key && s.btnPrimary)}
                onClick={() => setFilterTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {filteredBlocks.length === 0 ? (
          <p style={{ padding: 20, opacity: 0.7, textAlign: "center" }}>
            No hay bolsillos de ahorro para este filtro.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Plazo</th>
                  <th>Capital</th>
                  <th>Tasa E.A.</th>
                  <th>Interés</th>
                  <th>Total a Pagar</th>
                  <th>Día y Hora Exacta de Pago</th>
                  <th>Reserva 72h</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {filteredBlocks.map((b) => {
                  const isActive = b.status === "active" || b.status === "maturing_soon";
                  const escrow = b.escrowStatus ?? (b.status === "completed" ? "settled" : "unfunded");
                  return (
                    <tr key={b.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{b.customerName || b.userId}</div>
                        <div className={s.faint} style={{ fontSize: 12 }}>
                          {b.customerPhone || "—"} {b.customerEmail ? `· ${b.customerEmail}` : ""}
                        </div>
                        <div className={cx(s.mono, s.faint)} style={{ fontSize: 11 }}>
                          {b.id}
                        </div>
                      </td>
                      <td>
                        <strong>{b.termDays} días</strong>
                        <div>
                          <StatusBadge value={b.status} />
                        </div>
                      </td>
                      <td className={s.num}>{formatCopMinor(b.principalMinor)}</td>
                      <td className={s.num}>
                        <strong>{b.lockedRate}%</strong>
                      </td>
                      <td className={s.num} style={{ color: "#4cc79a", fontWeight: 600 }}>
                        +{formatCopMinor(b.expectedYieldMinor)}
                      </td>
                      <td className={s.num}>
                        <strong>{formatCopMinor(b.totalPayoutMinor)}</strong>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{formatDateTime(b.maturesAt)}</div>
                        <div className={s.faint} style={{ fontSize: 12 }}>
                          {formatCountdown(b.hoursRemaining, b.status)}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={escrow} />
                        {b.escrowFundedAt ? (
                          <div className={s.faint} style={{ fontSize: 11, marginTop: 2 }}>
                            {formatDateTime(b.escrowFundedAt)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {isActive && escrow !== "funded_locked" ? (
                          <GuardedButton
                            allowed={canWrite}
                            className={cx(s.btn, s.btnSm, s.btnPrimary)}
                            onClick={() => setLockTargetBlock(b)}
                          >
                            🔒 Colocar y bloquear
                          </GuardedButton>
                        ) : escrow === "funded_locked" ? (
                          <span className={s.faint} style={{ fontSize: 12 }}>
                            Listo p/ pago exacto
                          </span>
                        ) : (
                          <span className={s.faint} style={{ fontSize: 12 }}>
                            Reintegrado
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Configuración de Tasas por Plazo (30-60-90-180-360 días) */}
      <Panel
        title="Tasas por Plazo (30 · 60 · 90 · 180 · 360 días)"
        actions={
          canWrite ? (
            <button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => setSaveRatesOpen(true)}>
              Guardar nuevas tasas
            </button>
          ) : undefined
        }
      >
        <div style={{ padding: "6px 0" }}>
          <p className={s.faint} style={{ fontSize: 13, marginBottom: 14 }}>
            💡 <strong>Tasa Fija Garantizada:</strong> Cada cliente conserva la tasa vigente en el momento en que bloqueó su saldo,
            incluso si ajustas las tasas para futuras aperturas.
          </p>

          <table className={s.table}>
            <thead>
              <tr>
                <th>Plazo de bloqueo</th>
                <th>Tasa ofrecida (% E.A.)</th>
                <th>Estado</th>
                <th>Disponibilidad</th>
              </tr>
            </thead>
            <tbody>
              {ratesForm.map((tier) => (
                <tr key={tier.termDays}>
                  <td>
                    <strong>{tier.termDays} días</strong>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0.5"
                        max="35"
                        value={tier.ratePercent}
                        disabled={!canWrite}
                        onChange={(e) => handleRateChange(tier.termDays, "ratePercent", Number.parseFloat(e.target.value) || 0)}
                        className={s.input}
                        style={{ width: 96 }}
                      />
                      <span>% E.A.</span>
                    </div>
                  </td>
                  <td>
                    <StatusBadge value={tier.enabled ? "active" : "disabled"} />
                  </td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={tier.enabled}
                        disabled={!canWrite}
                        onChange={(e) => handleRateChange(tier.termDays, "enabled", e.target.checked)}
                      />
                      <span style={{ fontSize: 12 }}>{tier.enabled ? "Habilitado en la app" : "Pausado"}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Editor de Contrato Virtual */}
      <Panel
        title="Contrato Virtual y Términos del Bolsillo de Ahorro"
        actions={
          canWrite ? (
            <button type="button" className={cx(s.btn)} onClick={() => setSaveTermsOpen(true)}>
              Actualizar contrato
            </button>
          ) : undefined
        }
      >
        <div style={{ padding: "6px 0" }}>
          <p className={s.faint} style={{ fontSize: 13, marginBottom: 10 }}>
            Términos contractuales que el cliente visualiza y acepta antes de constituir su Bolsillo de Ahorro en iOS.
          </p>
          <textarea
            rows={7}
            value={contractTerms}
            disabled={!canWrite}
            onChange={(e) => setContractTerms(e.target.value)}
            className={s.input}
            style={{ width: "100%", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, lineHeight: 1.5 }}
          />
        </div>
      </Panel>

      {/* Diálogo Retirar / Abonar al Bolsillo Recaudo */}
      <ReasonDialog
        open={poolAction !== null}
        title={
          poolAction === "withdraw"
            ? "Retirar capital del Bolsillo Recaudo de Ahorros"
            : "Abonar capital y rendimientos al Bolsillo Recaudo"
        }
        description={
          poolAction === "withdraw"
            ? "Debita el Bolsillo Recaudo de Ahorros para utilizar el capital en operaciones productivas e inversión. Recuerda reintegrarlo y bloquearlo faltando 72 horas para cada vencimiento."
            : "Ingresa capital o rendimientos generados de vuelta al Bolsillo Recaudo de Ahorros para cubrir próximos vencimientos."
        }
        confirmLabel={poolAction === "withdraw" ? "Retirar del bolsillo" : "Abonar al bolsillo"}
        canConfirm={parsedPoolMinor > 0}
        onClose={() => setPoolAction(null)}
        onConfirm={submitPoolMovement}
      >
        <label className={s.field} style={{ marginBottom: 12 }}>
          <span>Monto en Pesos Colombianos (COP)</span>
          <input
            type="number"
            min="1000"
            step="1000"
            className={s.input}
            placeholder="Ej: 1500000"
            value={poolAmountCop}
            onChange={(e) => setPoolAmountCop(e.target.value)}
          />
          {parsedPoolMinor > 0 ? (
            <small className={s.faint}>Se registrará movimiento por {formatCopMinor(parsedPoolMinor)}</small>
          ) : null}
        </label>
      </ReasonDialog>

      {/* Diálogo Bloqueo 72h individual */}
      <ReasonDialog
        open={lockTargetBlock !== null}
        title="Colocar y bloquear capital + intereses (Reserva 72h)"
        description={
          lockTargetBlock
            ? `Se bloquearán ${formatCopMinor(lockTargetBlock.totalPayoutMinor)} para ${lockTargetBlock.customerName || lockTargetBlock.userId} (${lockTargetBlock.termDays} días). Cuando llegue exactamente el ${formatDateTime(lockTargetBlock.maturesAt)}, el sistema reintegrará automáticamente el dinero en la cuenta del cliente.`
            : ""
        }
        confirmLabel="Colocar y bloquear ahora"
        onClose={() => setLockTargetBlock(null)}
        onConfirm={submitSingleEscrowLock}
      />

      {/* Diálogo Bloqueo 72h en lote */}
      <ReasonDialog
        open={lockBatchOpen}
        title="Colocar y bloquear todos los vencimientos < 72 horas"
        description={`Se bloquearán ${formatCopMinor(unfunded72hMinor)} correspondientes a ${unfunded72hCount} bolsillo(s) que vencen en las próximas 72 horas para garantizar su reintegro automático en la hora exacta.`}
        confirmLabel="Bloquear lote 72h"
        onClose={() => setLockBatchOpen(false)}
        onConfirm={submitBatch72hLock}
      />

      <ReasonDialog
        open={saveRatesOpen}
        title="Confirmar ajuste de tasas de ahorro"
        description="Se actualizarán las tasas ofrecidas a nuevos clientes en la app móvil. Los bolsillos ya activos mantendrán su tasa intacta."
        confirmLabel="Confirmar y publicar"
        onClose={() => setSaveRatesOpen(false)}
        onConfirm={submitRates}
      />

      <ReasonDialog
        open={saveTermsOpen}
        title="Confirmar actualización del contrato virtual"
        description="El nuevo texto contractual entrará en vigencia inmediatamente para todas las nuevas aperturas."
        confirmLabel="Guardar contrato"
        onClose={() => setSaveTermsOpen(false)}
        onConfirm={submitContract}
      />
    </div>
  );
}
