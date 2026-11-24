"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { AdminCard, AdminCardStatus, CardKind, CardPurpose } from "@/lib/admin/types";
import {
  Badge,
  css as s,
  Empty,
  ErrorBox,
  GuardedButton,
  Kpi,
  PageHead,
  Pager,
  Panel,
  ReasonDialog,
  Skeleton,
  StatusBadge,
  useCursorPager,
  useToast,
} from "../ui";

export const CARD_PURPOSE: Record<CardPurpose, string> = {
  personal: "Personal",
  family: "Familiar",
  friend: "Amigo",
  online: "Compras online",
  other: "Otro",
};

export function CardKindBadge({ kind }: { kind: CardKind }) {
  return kind === "temporary" ? <Badge tone="warn">Temporal</Badge> : <Badge tone="info">Fija</Badge>;
}

/** "vence en 5 h 12 min" / "venció hace 3 h" para tarjetas temporales. */
export function expiryText(card: Pick<AdminCard, "kind" | "expiresAt">): string {
  if (card.kind !== "temporary" || !card.expiresAt) return "—";
  const diff = new Date(card.expiresAt).getTime() - Date.now();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h > 0 ? `${h} h ${m} min` : `${m} min`;
  return diff > 0 ? `vence en ${span}` : `venció hace ${span}`;
}

const isCancelable = (c: AdminCard) => c.status === "active" || c.status === "frozen";

/** Tabla de tarjetas reutilizada en el listado global y en la ficha del cliente. */
export function CardsTable({
  items,
  showCustomer,
  onCancel,
  canCancel,
}: {
  items: AdminCard[];
  showCustomer?: boolean;
  onCancel: (c: AdminCard) => void;
  canCancel: boolean;
}) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th>Tarjeta</th>
            {showCustomer ? <th>Cliente</th> : null}
            <th>Tipo</th>
            <th>Para</th>
            <th>Estado</th>
            <th>Vigencia</th>
            <th>Creada</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>{c.label}</strong>
                <div className={s.faint} style={{ fontSize: 12 }}>
                  {c.brand} •••• {c.lastFour}
                </div>
              </td>
              {showCustomer ? (
                <td>
                  <Link href={`/admin-portal/customers/?id=${c.customerId}`}>{c.customerName ?? c.customerId}</Link>
                </td>
              ) : null}
              <td>
                <CardKindBadge kind={c.kind} />
              </td>
              <td>{CARD_PURPOSE[c.purpose]}</td>
              <td>
                <StatusBadge value={c.status} />
                {c.canceledReason === "admin" ? <div className={s.faint} style={{ fontSize: 12 }}>por admin</div> : null}
              </td>
              <td className={s.faint}>{c.kind === "temporary" ? expiryText(c) : "Hasta que la elimine"}</td>
              <td className={s.faint}>{formatDateTime(c.createdAt)}</td>
              <td className={s.right}>
                {isCancelable(c) ? (
                  <GuardedButton allowed={canCancel} className={s.btnDanger} onClick={() => onCancel(c)}>
                    Cancelar
                  </GuardedButton>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Diálogo de cancelación forzada (queda en el audit log). */
export function CancelCardDialog({ card, onClose, onDone }: { card: AdminCard | null; onClose: () => void; onDone: (c: AdminCard) => void }) {
  const { api } = useSession();
  return (
    <ReasonDialog
      open={card !== null}
      title="Cancelar tarjeta virtual"
      description={
        card ? (
          <>
            Se cancela de forma irreversible en Coinsenda la tarjeta <strong>{card.label}</strong> (•••• {card.lastFour}) de{" "}
            {card.customerName ?? card.customerId}. Si era su última tarjeta activa, el saldo del bolsillo vuelve a su cuenta principal Bre-B.
          </>
        ) : null
      }
      confirmLabel="Cancelar tarjeta"
      danger
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!api || !card) return;
        const updated = await api.cancelCard(card.id, reason);
        onDone(updated);
      }}
    />
  );
}

export function CardsAdminView() {
  const sp = useSearchParams();
  const toast = useToast();
  const { can } = useSession();
  const [kind, setKind] = useState(sp.get("kind") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [purpose, setPurpose] = useState(sp.get("purpose") ?? "");
  const [canceling, setCanceling] = useState<AdminCard | null>(null);
  const key = [kind, status, purpose].join("|");
  const pager = useCursorPager(key);

  const { data, setData, error, loading, reload } = useLoad(
    (a) =>
      a.cards({
        kind: (kind || undefined) as CardKind | undefined,
        status: (status || undefined) as AdminCardStatus | undefined,
        purpose: (purpose || undefined) as CardPurpose | undefined,
        limit: 30,
        cursor: pager.cursor,
      }),
    [key, pager.cursor],
  );

  return (
    <>
      <PageHead
        title="Tarjetas virtuales"
        sub="Tarjetas adicionales de los clientes para familiares, amigos o compras online. Las FIJAS duran hasta que se eliminen; las TEMPORALES se cancelan solas en Coinsenda 24 h después de crearse."
      />
      {data ? (
        <div className={s.kpis}>
          <Kpi label="Fijas activas" value={data.summary.activeFixed} />
          <Kpi label="Temporales vigentes" value={data.summary.activeTemporary} />
          <Kpi label="Temporales vencidas (24 h)" value={data.summary.expiredLast24h} />
          <Kpi label="Emitidas (24 h)" value={data.summary.issuedLast24h} sub={`${data.summary.customersWithCards} clientes con tarjeta`} />
        </div>
      ) : null}
      <Panel bodyless>
        <div className={s.filters}>
          <select className={s.select} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">
            <option value="">Tipo: todas</option>
            <option value="fixed">Fija</option>
            <option value="temporary">Temporal</option>
          </select>
          <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
            <option value="">Estado: todos</option>
            <option value="active">Activa</option>
            <option value="frozen">Congelada</option>
            <option value="expired">Vencida</option>
            <option value="canceled">Cancelada</option>
          </select>
          <select className={s.select} value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Para quién">
            <option value="">Para: todos</option>
            {Object.entries(CARD_PURPOSE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBox message={error} onRetry={() => void reload()} />
          </div>
        ) : loading && !data ? (
          <Skeleton rows={10} />
        ) : data && data.items.length === 0 ? (
          <Empty>No hay tarjetas con esos filtros.</Empty>
        ) : data ? (
          <>
            <div style={{ opacity: loading ? 0.6 : 1 }}>
              <CardsTable items={data.items} showCustomer canCancel={can("customers:freeze")} onCancel={setCanceling} />
            </div>
            <Pager
              count={data.items.length}
              hasPrev={pager.hasPrev}
              hasNext={Boolean(data.nextCursor)}
              onPrev={pager.prev}
              onNext={() => pager.next(data.nextCursor)}
              label="tarjetas"
            />
          </>
        ) : null}
      </Panel>
      <CancelCardDialog
        card={canceling}
        onClose={() => setCanceling(null)}
        onDone={(updated) => {
          setCanceling(null);
          setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === updated.id ? updated : x)) } : d));
          toast("Tarjeta cancelada");
          void reload(true);
        }}
      />
    </>
  );
}
