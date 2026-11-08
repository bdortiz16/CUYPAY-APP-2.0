"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatDateTime, formatMinor, parseToMinor } from "@/lib/format";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { AdminTransaction } from "@/lib/admin/types";
import {
  Badge,
  css as s,
  cx,
  Empty,
  ErrorBox,
  GuardedButton,
  Money,
  PageHead,
  Pager,
  Panel,
  ReasonDialog,
  Skeleton,
  StatusBadge,
  TX_TYPE,
  useCursorPager,
  useToast,
} from "../ui";

export function TransactionsView() {
  const id = useSearchParams().get("id");
  return id ? <TransactionDetail id={id} /> : <TransactionsList />;
}

function signed(t: AdminTransaction) {
  return t.direction === "in" ? t.amountMinor : -t.amountMinor;
}

function TransactionsList() {
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const { api } = useSession();
  const [type, setType] = useState(sp.get("type") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [currency, setCurrency] = useState(sp.get("currency") ?? "");
  const [from, setFrom] = useState(sp.get("from") ?? "");
  const [to, setTo] = useState(sp.get("to") ?? "");
  const [minAmount, setMinAmount] = useState("");
  const [flagged, setFlagged] = useState(sp.get("flagged") ?? "");
  const customerId = sp.get("customerId") ?? "";
  const minAmountMinor = minAmount ? parseToMinor(minAmount) ?? undefined : undefined;
  const flaggedQ = flagged === "true" || flagged === "false" ? flagged : undefined;
  const key = [type, status, currency, from, to, minAmountMinor, customerId, flaggedQ].join("|");
  const pager = useCursorPager(key);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const { data, setData, error, loading, reload } = useLoad(
    (a) => a.transactions({ type, status, currency, from, to, minAmountMinor, customerId, flagged: flaggedQ, limit: 30, cursor: pager.cursor }),
    [key, pager.cursor],
  );

  useStreamEvent(["transaction.created", "transaction.updated"], (e) => {
    if (e.type !== "transaction.created" && e.type !== "transaction.updated") return;
    const t = e.data;
    setData((d) => {
      if (!d) return d;
      const idx = d.items.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        const items = d.items.slice();
        items[idx] = t;
        return { ...d, items };
      }
      // Solo insertar en la primera página y si coincide con los filtros simples
      const matches =
        !pager.hasPrev &&
        e.type === "transaction.created" &&
        (!type || t.type === type) &&
        (!status || t.status === status) &&
        (!currency || t.currency === currency) &&
        (!customerId || t.customerId === customerId) &&
        (!flaggedQ || String(t.flagged) === flaggedQ) &&
        !to &&
        (!minAmountMinor || t.amountMinor >= minAmountMinor);
      return matches ? { ...d, items: [t, ...d.items].slice(0, 30) } : d;
    });
    setFresh((f) => new Set(f).add(t.id));
    setTimeout(() => setFresh((f) => {
      const n = new Set(f);
      n.delete(t.id);
      return n;
    }), 1700);
  });

  const exportCsv = async () => {
    if (!api) return;
    setExporting(true);
    try {
      const blob = await api.exportCsv({ from, to, type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cuypay-transacciones-${from || "inicio"}-${to || "hoy"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("CSV exportado");
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : "No se pudo exportar", "bad");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHead
        title="Transacciones"
        sub={customerId ? <>Filtrado por cliente <span className={s.mono}>{customerId}</span> · <Link href="/admin-portal/transactions/">quitar</Link></> : "Depósitos Bre-B, envíos y conversiones COP → BRL."}
        actions={
          <button type="button" id="tx-export" className={s.btn} onClick={exportCsv} disabled={exporting}>
            {exporting ? "Exportando…" : "Exportar CSV"}
          </button>
        }
      />
      <Panel bodyless>
        <div className={s.filters}>
          <select className={s.select} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
            <option value="">Tipo: todos</option>
            <option value="deposit">Depósito</option>
            <option value="transfer">Envío</option>
            <option value="conversion">Conversión</option>
          </select>
          <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
            <option value="">Estado: todos</option>
            <option value="pending">Pendiente</option>
            <option value="completed">Completada</option>
            <option value="failed">Fallida</option>
            <option value="reversed">Reversada</option>
          </select>
          <select className={s.select} value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Moneda">
            <option value="">Moneda: todas</option>
            <option value="COP">COP</option>
            <option value="BRL">BRL</option>
          </select>
          <select className={s.select} value={flagged} onChange={(e) => setFlagged(e.target.value)} aria-label="Marcadas">
            <option value="">Marcadas: todas</option>
            <option value="true">Solo marcadas</option>
            <option value="false">Sin marcar</option>
          </select>
          <label className={s.row}>
            <span className={s.faint}>Desde</span>
            <input className={s.input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className={s.row}>
            <span className={s.faint}>Hasta</span>
            <input className={s.input} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <input
            className={s.input}
            style={{ flex: "0 1 160px" }}
            inputMode="numeric"
            placeholder="Monto mínimo COP"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            aria-label="Monto mínimo"
          />
        </div>
        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBox message={error} onRetry={() => void reload()} />
          </div>
        ) : loading && !data ? (
          <Skeleton rows={10} />
        ) : data && data.items.length === 0 ? (
          <Empty>No hay transacciones con esos filtros.</Empty>
        ) : data ? (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Cliente</th>
                    <th>Contraparte</th>
                    <th>Estado</th>
                    <th className={s.right}>Monto</th>
                    <th className={s.right}>Comisión</th>
                    <th className={s.right}>Recibe</th>
                  </tr>
                </thead>
                <tbody style={{ opacity: loading ? 0.6 : 1 }}>
                  {data.items.map((t) => (
                    <tr
                      key={t.id}
                      className={cx(s.clickRow, fresh.has(t.id) && s.flash)}
                      onClick={() => router.push(`/admin-portal/transactions/?id=${t.id}`)}
                    >
                      <td className={cx(s.faint, s.num)}>{formatDateTime(t.createdAt)}</td>
                      <td>
                        <Link href={`/admin-portal/transactions/?id=${t.id}`} onClick={(e) => e.stopPropagation()}>
                          {TX_TYPE[t.type]}
                        </Link>{" "}
                        {t.flagged ? <Badge tone="accent">Marcada</Badge> : null}
                      </td>
                      <td>
                        <Link href={`/admin-portal/customers/?id=${t.customerId}`} onClick={(e) => e.stopPropagation()}>
                          {t.customerName}
                        </Link>
                      </td>
                      <td className={s.muted}>{t.counterparty}</td>
                      <td>
                        <StatusBadge value={t.status} />
                      </td>
                      <td className={s.right}>
                        <Money minor={signed(t)} currency={t.currency} sign className={t.direction === "in" ? s.pos : undefined} />
                      </td>
                      <td className={cx(s.right, s.faint)}>{t.feeMinor ? <Money minor={t.feeMinor} currency={t.currency} /> : "—"}</td>
                      <td className={s.right}>
                        {t.conversion ? <Money minor={t.conversion.toAmountMinor} currency={t.conversion.toCurrency} className={s.pos} /> : <span className={s.faint}>—</span>}
                      </td>
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
              label="transacciones"
            />
          </>
        ) : null}
      </Panel>
    </>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Creada",
  held: "Fondos retenidos",
  provider_submitted: "Enviada al proveedor",
  provider_confirmed: "Confirmada por el proveedor",
  completed: "Completada",
  failed: "Fallida",
  reversed: "Reversada",
};

function TransactionDetail({ id }: { id: string }) {
  const { can, api } = useSession();
  const toast = useToast();
  const { data: t, error, loading, reload } = useLoad((a) => a.transaction(id), [id]);
  const [reverseOpen, setReverseOpen] = useState(false);

  useStreamEvent(["transaction.updated"], (e) => {
    if ((e.data as { id: string }).id === id) void reload(true);
  });

  if (error && !t) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !t) return <Panel title="Transacción"><Skeleton rows={8} /></Panel>;
  if (!t || !api) return null;

  const reversible = t.status === "completed" || t.status === "pending";
  const totals = t.ledgerEntries.reduce<Record<string, { d: number; c: number }>>((acc, e) => {
    acc[e.currency] ??= { d: 0, c: 0 };
    acc[e.currency].d += e.debitMinor;
    acc[e.currency].c += e.creditMinor;
    return acc;
  }, {});

  return (
    <>
      <div className={s.row}>
        <Link href="/admin-portal/transactions/">← Transacciones</Link>
      </div>
      <PageHead
        title={`${TX_TYPE[t.type]} · ${formatMinor(t.amountMinor, t.currency)}`}
        sub={
          <span className={s.row}>
            <span className={s.mono}>{t.id}</span>
            <StatusBadge value={t.status} />
            {t.flagged ? <Badge tone="accent">Marcada por cumplimiento</Badge> : null}
          </span>
        }
        actions={
          <GuardedButton
            allowed={can("treasury:write")}
            hideIfDenied={false}
            className={s.btnDanger}
            disabled={!reversible}
            id="tx-reverse"
            onClick={() => setReverseOpen(true)}
            title={!reversible ? "Solo se reversan transacciones completadas o pendientes" : undefined}
          >
            Reversar
          </GuardedButton>
        }
      />

      <div className={s.grid3}>
        <Panel title="Detalle">
          <dl className={s.dl}>
            <dt>Cliente</dt>
            <dd>
              <Link href={`/admin-portal/customers/?id=${t.customerId}`}>{t.customerName}</Link>
            </dd>
            <dt>Dirección</dt>
            <dd>{t.direction === "in" ? "Entrada" : "Salida"}</dd>
            <dt>Contraparte</dt>
            <dd>{t.counterparty}</dd>
            <dt>Monto</dt>
            <dd>
              <Money minor={t.amountMinor} currency={t.currency} />
            </dd>
            <dt>Comisión</dt>
            <dd>
              <Money minor={t.feeMinor} currency={t.currency} />
            </dd>
            <dt>Creada</dt>
            <dd>{formatDateTime(t.createdAt)}</dd>
            <dt>Actualizada</dt>
            <dd>{formatDateTime(t.updatedAt)}</dd>
          </dl>
        </Panel>

        <Panel title="Conversión y proveedor">
          <dl className={s.dl}>
            {t.conversion ? (
              <>
                <dt>De</dt>
                <dd>
                  <Money minor={t.conversion.fromAmountMinor} currency={t.conversion.fromCurrency} />
                </dd>
                <dt>A</dt>
                <dd>
                  <Money minor={t.conversion.toAmountMinor} currency={t.conversion.toCurrency} className={s.pos} />
                </dd>
                <dt>Tasa</dt>
                <dd className={s.mono}>{t.conversion.rate.toFixed(8)}</dd>
              </>
            ) : null}
            {Object.entries(t.providerRefs).map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd className={s.mono}>{v}</dd>
              </span>
            ))}
            {!t.conversion && Object.keys(t.providerRefs).length === 0 ? (
              <>
                <dt>—</dt>
                <dd className={s.faint}>Sin referencias</dd>
              </>
            ) : null}
          </dl>
        </Panel>

        <Panel title="Línea de tiempo">
          <ol className={s.timeline}>
            {t.timeline.map((e, i) => (
              <li key={i}>
                <strong>{EVENT_LABEL[e.event] ?? e.event}</strong>
                <div className={s.muted}>{e.detail}</div>
                <div className={s.faint} style={{ fontSize: 12 }}>
                  {formatDateTime(e.at)}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <Panel title="Asientos contables (ledger)" bodyless>
        {t.ledgerEntries.length === 0 ? (
          <Empty>Sin asientos (la operación falló antes de contabilizarse).</Empty>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th>Moneda</th>
                  <th className={s.right}>Débito</th>
                  <th className={s.right}>Crédito</th>
                </tr>
              </thead>
              <tbody>
                {t.ledgerEntries.map((e, i) => (
                  <tr key={i}>
                    <td className={s.mono}>{e.account}</td>
                    <td>{e.currency}</td>
                    <td className={s.right}>{e.debitMinor ? <Money minor={e.debitMinor} currency={e.currency} /> : <span className={s.faint}>—</span>}</td>
                    <td className={s.right}>{e.creditMinor ? <Money minor={e.creditMinor} currency={e.currency} /> : <span className={s.faint}>—</span>}</td>
                  </tr>
                ))}
                {Object.entries(totals).map(([cur, v]) => (
                  <tr key={cur}>
                    <td className={s.faint}>Total {cur}</td>
                    <td>
                      {v.d === v.c ? <Badge tone="ok">Cuadra</Badge> : <Badge tone="bad">Descuadre</Badge>}
                    </td>
                    <td className={s.right}>
                      <Money minor={v.d} currency={cur as "COP" | "BRL"} />
                    </td>
                    <td className={s.right}>
                      <Money minor={v.c} currency={cur as "COP" | "BRL"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ReasonDialog
        open={reverseOpen}
        title="Reversar transacción"
        description="Crea asientos de reverso y deja la transacción en estado reversada. Esta acción no se puede deshacer."
        confirmLabel="Reversar"
        danger
        onClose={() => setReverseOpen(false)}
        onConfirm={async (reason) => {
          const res = await api.reverse(t.id, reason);
          toast(`Transacción reversada · asiento ${res.journalId}`);
          for (const w of res.warnings ?? []) toast(`Atención: ${w}`, "info");
          void reload(true);
        }}
      />
    </>
  );
}
