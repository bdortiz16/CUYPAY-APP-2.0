"use client";

import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { SavingsBlockDto, SavingsConfigDto, SavingsRateTierDto } from "@/lib/admin/types";
import { RequirePerm } from "../AdminShell";
import { css as s, cx, ErrorBox, GuardedButton, Kpi, PageHead, Panel, ReasonDialog, Skeleton, StatusBadge, useToast } from "../ui";

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
  if (loading && !config) return <Panel title="Bloques de Ahorro"><Skeleton rows={8} /></Panel>;
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
  const blocksLoad = useLoad((a) => a.savingsBlocks(), []);
  const alertsLoad = useLoad((a) => a.treasurySavingsAlerts(), []);

  const [ratesForm, setRatesForm] = useState<SavingsRateTierDto[]>(() =>
    initialConfig.rates.map((r: SavingsRateTierDto) => ({ ...r }))
  );
  const [contractTerms, setContractTerms] = useState(initialConfig.contractTerms);
  const [saveRatesOpen, setSaveRatesOpen] = useState(false);
  const [saveTermsOpen, setSaveTermsOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const canWrite = can("treasury:write");

  if (!api) return null;

  const blocks: SavingsBlockDto[] = blocksLoad.data?.items ?? [];
  const alerts = alertsLoad.data;

  // KPIs
  let totalPrincipal = 0;
  let totalExpectedYield = 0;
  let activeCount = 0;

  for (const b of blocks) {
    if (b.status === "active" || b.status === "maturing_soon") {
      totalPrincipal += Number(b.principalMinor);
      totalExpectedYield += Number(b.expectedYieldMinor);
      activeCount++;
    }
  }

  const handleRateChange = (termDays: number, field: "ratePercent" | "enabled", value: number | boolean) => {
    setRatesForm((prev) =>
      prev.map((r) => (r.termDays === termDays ? { ...r, [field]: value } : r)),
    );
  };

  const submitRates = async (reason: string) => {
    try {
      const updated = await api.updateSavingsConfig(ratesForm, undefined, reason);
      onUpdate(updated);
      toast("Tasas de ahorro actualizadas exitosamente.", "ok");
    } catch {
      toast("Error al actualizar las tasas.", "bad");
    }
  };

  const submitContract = async (reason: string) => {
    try {
      const updated = await api.updateSavingsConfig(ratesForm, contractTerms, reason);
      onUpdate(updated);
      toast("Contrato virtual actualizado.", "ok");
    } catch {
      toast("Error al actualizar el contrato.", "bad");
    }
  };

  const runMaturitySettlement = async () => {
    setIsProcessing(true);
    try {
      const res = await api.processSavingsMaturities();
      toast(`Liquidación ejecutada: ${res.completedCount} bloque(s) acreditados.`, "ok");
      void blocksLoad.reload();
      void alertsLoad.reload();
    } catch {
      toast("Error al procesar liquidación.", "bad");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className={s.stack}>
      <PageHead
        title="Bloques de Ahorro"
        sub="Gestión de rendimientos a plazo fijo garantizados, custodia de tesorería y alertas 72h."
        actions={
          <GuardedButton
            allowed={canWrite}
            className={cx(s.btn, s.btnPrimary)}
            onClick={runMaturitySettlement}
            disabled={isProcessing}
          >
            {isProcessing ? "Procesando…" : "⚡ Ejecutar liquidación de vencidos"}
          </GuardedButton>
        }
      />

      {/* Alerta operativa de tesorería: Ventana 72 horas */}
      {alerts && alerts.totalMaturingCount > 0 ? (
        <div
          style={{
            background: "rgba(224, 86, 36, 0.12)",
            border: "1px solid rgba(224, 86, 36, 0.35)",
            borderRadius: "16px",
            padding: "18px 24px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "22px" }}>⚠️</span>
            <strong style={{ fontSize: "16px", color: "var(--color-primary, #1A4D46)" }}>
              Alerta de Cobertura de Caja — Ventana de 72 Horas
            </strong>
          </div>
          <p style={{ margin: 0, fontSize: "14px", color: "var(--color-text, #333)" }}>
            Hay <strong>{alerts.totalMaturingCount} bloque(s)</strong> que vencen en menos de 72 horas.
            Se requiere asegurar la suma de <strong>${(Number(alerts.totalMaturing72hMinor) / 100).toLocaleString("es-CO")} COP</strong> en la caja de liquidación de Coinsenda para garantizar el desembolso automático sin fricción.
          </p>
        </div>
      ) : null}

      {/* KPI Tiles */}
      <div className={s.grid4}>
        <Kpi
          label="Capital en Bóveda (Coinsenda)"
          value={`$${(totalPrincipal / 100).toLocaleString("es-CO")} COP`}
          sub="Fondos disponibles para movilizar"
        />
        <Kpi
          label="Intereses a Liquidar"
          value={`$${(totalExpectedYield / 100).toLocaleString("es-CO")} COP`}
          sub="Rendimiento fijo devengado"
        />
        <Kpi label="Bloques Activos" value={String(activeCount)} sub="Contratos vigentes" />
        <Kpi
          label="Vencen en < 72 Horas"
          value={alerts ? `$${(Number(alerts.totalMaturing72hMinor) / 100).toLocaleString("es-CO")} COP` : "0 COP"}
          sub={alerts ? `${alerts.totalMaturingCount} por liquidar` : "Sin vencimientos inmediatos"}
        />
      </div>

      {/* Configuración de Tasas por Plazo */}
      <Panel
        title="Tasas de Rendimiento Ofrecidas (Garantía Fija)"
        actions={
          canWrite ? (
            <button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => setSaveRatesOpen(true)}>
              Guardar nuevas tasas
            </button>
          ) : undefined
        }
      >
        <div style={{ padding: "8px 0" }}>
          <p style={{ fontSize: "13px", color: "#666", marginBottom: "16px" }}>
            💡 <strong>Regla de Tasa Fija Inmutable:</strong> Cuando un cliente constituye un bloque (ej. 30 días al 3.0%),
            su rendimiento queda sellado contractualmente. Si cambias la tasa a 2.5%, el cliente mantiene su 3.0% garantizado
            hasta el vencimiento.
          </p>

          <table className={s.table}>
            <thead>
              <tr>
                <th>Plazo</th>
                <th>Tasa Ofrecida (% E.A.)</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {ratesForm.map((tier) => (
                <tr key={tier.termDays}>
                  <td>
                    <strong>{tier.termDays} días</strong>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0.5"
                        max="35"
                        value={tier.ratePercent}
                        disabled={!canWrite}
                        onChange={(e) => handleRateChange(tier.termDays, "ratePercent", Number.parseFloat(e.target.value) || 0)}
                        className={s.input}
                        style={{ width: "90px" }}
                      />
                      <span>%</span>
                    </div>
                  </td>
                  <td>
                    <StatusBadge value={tier.enabled ? "active" : "disabled"} />
                  </td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={tier.enabled}
                        disabled={!canWrite}
                        onChange={(e) => handleRateChange(tier.termDays, "enabled", e.target.checked)}
                      />
                      <span style={{ fontSize: "12px" }}>{tier.enabled ? "Habilitado" : "Pausado"}</span>
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
        title="Contrato Virtual y Términos de Ahorro"
        actions={
          canWrite ? (
            <button type="button" className={cx(s.btn, s.btnOutline)} onClick={() => setSaveTermsOpen(true)}>
              Actualizar contrato
            </button>
          ) : undefined
        }
      >
        <div style={{ padding: "8px 0" }}>
          <p style={{ fontSize: "13px", color: "#666", marginBottom: "12px" }}>
            Texto legal y términos que el usuario visualiza y firma biométricamente (Face ID) en la app móvil.
          </p>
          <textarea
            rows={7}
            value={contractTerms}
            disabled={!canWrite}
            onChange={(e) => setContractTerms(e.target.value)}
            className={s.input}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.5" }}
          />
        </div>
      </Panel>

      {/* Listado de Bloques de Clientes */}
      <Panel title={`Historial de Bloques en Custodia (${blocks.length})`}>
        {blocks.length === 0 ? (
          <p style={{ padding: "20px", color: "#888", textAlign: "center" }}>
            Aún no se han constituido bloques de ahorro.
          </p>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>ID Bloque</th>
                <th>Cliente</th>
                <th>Plazo</th>
                <th>Capital Bloqueado</th>
                <th>Tasa Fija</th>
                <th>Rendimiento</th>
                <th>Total a Pagar</th>
                <th>Vencimiento</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id}>
                  <td>
                    <span className={s.mono}>{b.id.slice(0, 12)}…</span>
                  </td>
                  <td>
                    <span className={s.mono}>{b.userId.slice(0, 10)}…</span>
                  </td>
                  <td>
                    <strong>{b.termDays} días</strong>
                  </td>
                  <td>${(Number(b.principalMinor) / 100).toLocaleString("es-CO")} COP</td>
                  <td>
                    <strong>{b.lockedRate}%</strong>
                  </td>
                  <td style={{ color: "#1A4D46" }}>
                    +${(Number(b.expectedYieldMinor) / 100).toLocaleString("es-CO")} COP
                  </td>
                  <td>
                    <strong>${(Number(b.totalPayoutMinor) / 100).toLocaleString("es-CO")} COP</strong>
                  </td>
                  <td>{formatDateTime(b.maturesAt)}</td>
                  <td>
                    <StatusBadge value={b.status === "completed" ? "active" : b.status === "active" ? "pending" : "disabled"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <ReasonDialog
        open={saveRatesOpen}
        title="Confirmar ajuste de tasas de ahorro"
        description="Se actualizarán las tasas ofrecidas a nuevos clientes en la app móvil. Las pólizas ya activas mantendrán su tasa intacta."
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
