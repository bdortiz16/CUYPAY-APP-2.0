"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatDateTime, formatMinor, parseToMinor, timeAgo } from "@/lib/format";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { LimitItem, LimitOperation, LimitPeriod, Tier } from "@/lib/admin/types";
import {
  css as s,
  cx,
  Empty,
  ErrorBox,
  GuardedButton,
  LimitBar,
  Money,
  OPERATION,
  PageHead,
  Pager,
  Panel,
  PERIOD,
  ReasonDialog,
  Skeleton,
  StatusBadge,
  TIER,
  TX_TYPE,
  useCursorPager,
  useToast,
} from "../ui";

export function CustomersView() {
  const id = useSearchParams().get("id");
  return id ? <CustomerDetail id={id} /> : <CustomersList />;
}

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function CustomersList() {
  const router = useRouter();
  const sp = useSearchParams();
  const [query, setQuery] = useState(sp.get("query") ?? "");
  const [kyc, setKyc] = useState(sp.get("kycStatus") ?? "");
  const [tier, setTier] = useState(sp.get("tier") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const q = useDebounced(query);
  const key = [q, kyc, tier, status].join("|");
  const pager = useCursorPager(key);
  const { data, error, loading, reload } = useLoad(
    (api) => api.customers({ query: q, kycStatus: kyc, tier, status, limit: 25, cursor: pager.cursor }),
    [key, pager.cursor],
  );
  useStreamEvent(["customer.created", "customer.updated", "kyc.updated"], () => {
    if (!pager.hasPrev) void reload(true);
  });

  return (
    <>
      <PageHead title="Clientes" sub="Busca por nombre, correo, teléfono, documento o alias Bre-B." />
      <Panel bodyless>
        <div className={s.filters}>
          <input
            id="customers-search"
            className={s.input}
            type="search"
            placeholder="Buscar… (ej. ana, @cuypay, 300 123)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar clientes"
          />
          <select className={s.select} value={kyc} onChange={(e) => setKyc(e.target.value)} aria-label="Estado KYC">
            <option value="">KYC: todos</option>
            <option value="approved">Aprobado</option>
            <option value="pending">Pendiente</option>
            <option value="retry">Reintentar</option>
            <option value="rejected">Rechazado</option>
            <option value="not_started">Sin iniciar</option>
          </select>
          <select className={s.select} value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Nivel">
            <option value="">Nivel: todos</option>
            <option value="basic">Básico</option>
            <option value="full">Completo</option>
          </select>
          <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
            <option value="">Estado: todos</option>
            <option value="active">Activo</option>
            <option value="frozen">Congelado</option>
          </select>
        </div>
        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBox message={error} onRetry={() => void reload()} />
          </div>
        ) : loading && !data ? (
          <Skeleton rows={8} />
        ) : data && data.items.length === 0 ? (
          <Empty>No hay clientes con esos filtros.</Empty>
        ) : data ? (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Teléfono</th>
                    <th>KYC</th>
                    <th>Nivel</th>
                    <th>Riesgo</th>
                    <th>Estado</th>
                    <th className={s.right}>Saldo COP</th>
                    <th className={s.right}>Saldo BRL</th>
                    <th>Última actividad</th>
                  </tr>
                </thead>
                <tbody style={{ opacity: loading ? 0.6 : 1 }}>
                  {data.items.map((c) => (
                    <tr
                      key={c.id}
                      className={s.clickRow}
                      onClick={() => router.push(`/admin-portal/customers/?id=${c.id}`)}
                    >
                      <td>
                        <Link href={`/admin-portal/customers/?id=${c.id}`} onClick={(e) => e.stopPropagation()}>
                          {c.firstName} {c.lastName}
                        </Link>
                        <div className={s.faint} style={{ fontSize: 12 }}>
                          {c.email}
                        </div>
                      </td>
                      <td className={cx(s.num, s.mono)}>{c.phone}</td>
                      <td>
                        <StatusBadge value={c.kycStatus} />
                      </td>
                      <td>{TIER[c.tier]}</td>
                      <td>
                        <StatusBadge value={c.riskLevel} />
                      </td>
                      <td>
                        <StatusBadge value={c.status} />
                      </td>
                      <td className={s.right}>
                        <Money minor={c.balances.COP} currency="COP" />
                      </td>
                      <td className={s.right}>
                        <Money minor={c.balances.BRL} currency="BRL" />
                      </td>
                      <td className={s.faint}>{timeAgo(c.lastActiveAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              count={data.items.length}
              hasPrev={pager.hasPrev}
              hasNext={!!data.nextCursor}
              onPrev={pager.prev}
              onNext={() => pager.next(data.nextCursor)}
              label="clientes"
            />
          </>
        ) : null}
      </Panel>
    </>
  );
}

type Dialog =
  | { kind: "freeze" }
  | { kind: "unfreeze" }
  | { kind: "tier" }
  | { kind: "overrides" }
  | { kind: "revoke"; deviceId: string; name: string }
  | null;

const OPS: LimitOperation[] = ["transfer_out", "conversion", "deposit_in"];
const PERIODS: LimitPeriod[] = ["daily", "monthly", "annual"];

function CustomerDetail({ id }: { id: string }) {
  const { can, api } = useSession();
  const toast = useToast();
  const { data: c, error, loading, reload } = useLoad((a) => a.customer(id), [id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newTier, setNewTier] = useState<Tier>("full");
  const [overrides, setOverrides] = useState<{ operation: LimitOperation; period: LimitPeriod; value: string }[]>([]);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useStreamEvent(["customer.updated", "kyc.updated", "transaction.created", "transaction.updated"], (e) => {
    const d = e.data as { customerId?: string; id?: string };
    if (d.customerId === id || (e.type === "customer.updated" && d.id === id)) void reload(true);
  });

  if (error && !c) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !c) return <Panel title="Cliente"><Skeleton rows={8} /></Panel>;
  if (!c || !api) return null;

  const done = (msg: string) => {
    toast(msg);
    void reload(true);
  };

  const openOverrides = () => {
    setOverrides(
      c.limitOverrides.map((o) => ({ operation: o.operation, period: o.period, value: String(Math.round(o.limitMinor / 100)) })),
    );
    setDialog({ kind: "overrides" });
  };

  const canFreeze = can("customers:freeze");
  const canTier = can("customers:limits");
  const canSupport = can("customers:support");

  return (
    <>
      <div className={s.row}>
        <Link href="/admin-portal/customers/">← Clientes</Link>
      </div>
      <PageHead
        title={`${c.firstName} ${c.lastName}`}
        sub={
          <span className={s.row}>
            <span className={s.mono}>{c.id}</span>
            <StatusBadge value={c.status} />
            <StatusBadge value={c.kycStatus} prefix="KYC" />
            <StatusBadge value={c.riskLevel} prefix="Riesgo" />
          </span>
        }
        actions={
          <>
            {c.status === "active" ? (
              <GuardedButton allowed={canFreeze} className={s.btnDanger} id="customer-freeze" onClick={() => setDialog({ kind: "freeze" })}>
                Congelar
              </GuardedButton>
            ) : (
              <GuardedButton allowed={canFreeze} className={s.btnPrimary} id="customer-unfreeze" onClick={() => setDialog({ kind: "unfreeze" })}>
                Descongelar
              </GuardedButton>
            )}
            <GuardedButton
              allowed={canTier}
              id="customer-tier"
              onClick={() => {
                setNewTier(c.tier === "full" ? "basic" : "full");
                setDialog({ kind: "tier" });
              }}
            >
              Cambiar nivel
            </GuardedButton>
            <GuardedButton allowed={canTier} id="customer-overrides" onClick={openOverrides}>
              Overrides de límites
            </GuardedButton>
          </>
        }
      />

      <div className={s.grid3}>
        <Panel title="Datos">
          <dl className={s.dl}>
            <dt>Correo</dt>
            <dd>{c.email}</dd>
            <dt>Teléfono</dt>
            <dd className={s.mono}>{c.phone}</dd>
            <dt>Documento</dt>
            <dd className={s.mono}>
              {c.documentType || c.documentNumber ? (
                <>
                  {c.documentType ?? ""} {c.documentNumber ?? ""}
                  {!can("pii:read") ? <span className={s.faint}> · enmascarado</span> : null}
                </>
              ) : (
                <span className={s.faint}>Pendiente (KYC aún no lo persiste)</span>
              )}
            </dd>
            <dt>País</dt>
            <dd>{c.country}</dd>
            <dt>Nivel</dt>
            <dd>{TIER[c.tier]}</dd>
            <dt>Llave Bre-B</dt>
            <dd>
              {c.brebKey ? (
                <>
                  <span className={s.mono}>{c.brebKey.alias}</span> <StatusBadge value={c.brebKey.status} />
                </>
              ) : (
                <span className={s.faint}>Sin llave</span>
              )}
            </dd>
            <dt>Alta</dt>
            <dd>{formatDateTime(c.createdAt)}</dd>
            <dt>Última actividad</dt>
            <dd>{formatDateTime(c.lastActiveAt)}</dd>
          </dl>
        </Panel>

        <Panel title="KYC · Sumsub">
          <dl className={s.dl}>
            <dt>Estado</dt>
            <dd>
              <StatusBadge value={c.kyc.status} />
            </dd>
            <dt>Respuesta</dt>
            <dd>{c.kyc.reviewAnswer ?? "—"}</dd>
            <dt>Applicant ID</dt>
            <dd className={s.mono}>{c.kyc.applicantId}</dd>
            <dt>Motivos</dt>
            <dd>{c.kyc.rejectLabels.length ? c.kyc.rejectLabels.join(", ") : "—"}</dd>
            <dt>Actualizado</dt>
            <dd>{formatDateTime(c.kyc.updatedAt)}</dd>
          </dl>
        </Panel>

        <Panel title="Bolsillos" bodyless>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Moneda</th>
                <th className={s.right}>Saldo</th>
                <th className={s.right}>Disponible</th>
                <th className={s.right}>Retenido</th>
              </tr>
            </thead>
            <tbody>
              {c.wallets.map((w) => (
                <tr key={w.currency}>
                  <td>{w.currency}</td>
                  <td className={s.right}>
                    <Money minor={w.balanceMinor} currency={w.currency} />
                  </td>
                  <td className={s.right}>
                    <Money minor={w.availableMinor} currency={w.currency} />
                  </td>
                  <td className={s.right}>
                    <Money minor={w.heldMinor} currency={w.currency} className={w.heldMinor ? s.neg : s.faint} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className={s.grid2}>
        <Panel title={`Límites · nivel ${TIER[c.limits.tier]}`} bodyless>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Operación</th>
                <th>Periodo</th>
                <th className={s.right}>Usado / Límite</th>
                <th style={{ width: 120 }}>Uso</th>
              </tr>
            </thead>
            <tbody>
              {c.limits.items.map((l) => {
                const overridden = c.limitOverrides.some((o) => o.operation === l.operation && o.period === l.period);
                return (
                  <tr key={`${l.operation}-${l.period}`}>
                    <td>
                      {OPERATION[l.operation]} {overridden ? <span className={s.badge}>override</span> : null}
                    </td>
                    <td>{PERIOD[l.period]}</td>
                    <td className={cx(s.right, s.num)}>
                      {formatMinor(l.usedMinor ?? 0, "COP")} <span className={s.faint}>/ {formatMinor(l.limitMinor, "COP")}</span>
                    </td>
                    <td>
                      <LimitBar used={l.usedMinor ?? 0} limit={l.limitMinor} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Dispositivos" bodyless>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Dispositivo</th>
                <th>Registrado</th>
                <th>Último uso</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.name}
                    <div className={cx(s.mono, s.faint)}>{d.id}</div>
                  </td>
                  <td className={s.faint}>{formatDateTime(d.createdAt)}</td>
                  <td className={s.faint}>{timeAgo(d.lastUsedAt)}</td>
                  <td className={s.right}>
                    {d.revoked ? (
                      <span className={s.badge}>Revocado</span>
                    ) : (
                      <GuardedButton
                        allowed={canSupport}
                        className={cx(s.btnSm, s.btnDanger)}
                        onClick={() => setDialog({ kind: "revoke", deviceId: d.id, name: d.name })}
                      >
                        Revocar
                      </GuardedButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className={s.grid2}>
        <Panel title="Transacciones recientes" actions={<Link href={`/admin-portal/transactions/?customerId=${c.id}`}>Ver todas</Link>} bodyless>
          {c.recentTransactions.length === 0 ? (
            <Empty>Sin transacciones.</Empty>
          ) : (
            <table className={s.table}>
              <tbody>
                {c.recentTransactions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/admin-portal/transactions/?id=${t.id}`}>{TX_TYPE[t.type]}</Link>
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {t.counterparty}
                      </div>
                    </td>
                    <td className={s.faint}>{formatDateTime(t.createdAt)}</td>
                    <td>
                      <StatusBadge value={t.status} />
                    </td>
                    <td className={s.right}>
                      <Money
                        minor={t.direction === "in" ? t.amountMinor : -t.amountMinor}
                        currency={t.currency}
                        sign
                        className={t.direction === "in" ? s.pos : undefined}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Beneficiarios" bodyless>
          {c.beneficiaries.length === 0 ? (
            <Empty>Sin beneficiarios inscritos.</Empty>
          ) : (
            <table className={s.table}>
              <tbody>
                {c.beneficiaries.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.holderName}
                      <div className={s.faint} style={{ fontSize: 12 }}>
                        {b.bankName} · <span className={s.mono}>{b.alias}</span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={b.aml.result} prefix="AML" />
                    </td>
                    <td className={s.right}>
                      <StatusBadge value={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Notas internas">
        <form
          className={s.stack}
          onSubmit={async (e) => {
            e.preventDefault();
            const len = note.trim().length;
            if (len < 3 || len > 1000) {
              toast("La nota debe tener entre 3 y 1000 caracteres.", "bad");
              return;
            }
            setSavingNote(true);
            try {
              await api.addNote(c.id, note);
              setNote("");
              done("Nota guardada");
            } catch (ex) {
              toast(ex instanceof Error ? ex.message : "Error", "bad");
            } finally {
              setSavingNote(false);
            }
          }}
        >
          <textarea
            id="customer-note"
            className={s.textarea}
            placeholder="Escribe una nota visible solo para el equipo…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            disabled={!canSupport}
          />
          <div className={s.row}>
            <GuardedButton type="submit" allowed={canSupport} className={s.btnPrimary} disabled={savingNote || note.trim().length < 3}>
              Agregar nota
            </GuardedButton>
            <span className={s.faint}>La nota cuenta como motivo en el audit log.</span>
          </div>
        </form>
        {c.notes.length ? (
          <ul className={s.timeline} style={{ marginTop: 16 }}>
            {c.notes.map((n) => (
              <li key={n.id}>
                <div>{n.text}</div>
                <div className={s.faint} style={{ fontSize: 12 }}>
                  {n.author} · {formatDateTime(n.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {/* Diálogos */}
      <ReasonDialog
        open={dialog?.kind === "freeze"}
        title="Congelar cliente"
        description="Bloquea login, envíos y conversiones. Los depósitos siguen entrando y quedan retenidos."
        confirmLabel="Congelar"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await api.freeze(c.id, reason);
          done("Cliente congelado");
        }}
      />
      <ReasonDialog
        open={dialog?.kind === "unfreeze"}
        title="Descongelar cliente"
        confirmLabel="Descongelar"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const res = await api.unfreeze(c.id, reason);
          done(
            res?.releasedHeldMinor
              ? `Cliente descongelado · se liberaron ${formatMinor(res.releasedHeldMinor, "COP")} retenidos`
              : "Cliente descongelado",
          );
        }}
      />
      <ReasonDialog
        open={dialog?.kind === "tier"}
        title="Cambiar nivel"
        description={`Nivel actual: ${TIER[c.tier]}.`}
        confirmLabel="Guardar nivel"
        canConfirm={newTier !== c.tier}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await api.setTier(c.id, newTier, reason);
          done(`Nivel cambiado a ${TIER[newTier]}`);
        }}
      >
        <label className={s.field}>
          <span>Nuevo nivel</span>
          <select className={s.select} value={newTier} onChange={(e) => setNewTier(e.target.value as Tier)}>
            <option value="basic">Básico</option>
            <option value="full">Completo</option>
          </select>
        </label>
      </ReasonDialog>
      <ReasonDialog
        open={dialog?.kind === "overrides"}
        title="Overrides de límites"
        description="Reemplazan el límite del nivel para este cliente. Deja la lista vacía para quitar todos los overrides. Montos en pesos (COP)."
        confirmLabel="Guardar overrides"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const items: LimitItem[] = overrides.map((o) => {
            const minor = parseToMinor(o.value);
            if (minor === null) throw new Error("Revisa los montos: hay un valor inválido.");
            return { operation: o.operation, period: o.period, limitMinor: minor };
          });
          const keys = new Set(items.map((i) => `${i.operation}-${i.period}`));
          if (keys.size !== items.length) throw new Error("Hay overrides repetidos para la misma operación y periodo.");
          await api.setLimitOverrides(c.id, items, reason);
          done(items.length ? "Overrides guardados" : "Overrides eliminados");
        }}
      >
        <div className={s.stack}>
          {overrides.map((o, i) => (
            <div key={i} className={s.row} style={{ flexWrap: "nowrap" }}>
              <select
                className={s.select}
                value={o.operation}
                onChange={(e) => setOverrides((x) => x.map((y, j) => (j === i ? { ...y, operation: e.target.value as LimitOperation } : y)))}
                aria-label="Operación"
              >
                {OPS.map((op) => (
                  <option key={op} value={op}>
                    {OPERATION[op]}
                  </option>
                ))}
              </select>
              <select
                className={s.select}
                value={o.period}
                onChange={(e) => setOverrides((x) => x.map((y, j) => (j === i ? { ...y, period: e.target.value as LimitPeriod } : y)))}
                aria-label="Periodo"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {PERIOD[p]}
                  </option>
                ))}
              </select>
              <input
                className={s.input}
                inputMode="numeric"
                value={o.value}
                onChange={(e) => setOverrides((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
                placeholder="Monto COP"
                aria-label="Límite en COP"
                style={{ flex: 1 }}
              />
              <button type="button" className={cx(s.btn, s.btnSm, s.btnGhost)} onClick={() => setOverrides((x) => x.filter((_, j) => j !== i))} aria-label="Quitar">
                ✕
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={cx(s.btn, s.btnSm)}
              onClick={() => setOverrides((x) => [...x, { operation: "transfer_out", period: "daily", value: "" }])}
            >
              + Agregar override
            </button>
          </div>
        </div>
      </ReasonDialog>
      <ReasonDialog
        open={dialog?.kind === "revoke"}
        title="Revocar dispositivo"
        description={dialog?.kind === "revoke" ? `${dialog.name} dejará de poder iniciar sesión y firmar operaciones.` : undefined}
        confirmLabel="Revocar"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (dialog?.kind !== "revoke") return;
          await api.revokeDevice(c.id, dialog.deviceId, reason);
          done("Dispositivo revocado");
        }}
      />
    </>
  );
}
