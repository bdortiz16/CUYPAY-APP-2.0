"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { formatDateTime, formatMinor, parseToMinor, pct, timeAgo } from "@/lib/format";
import { ROLE_LABEL, ROLES } from "@/lib/admin/rbac";
import { useSession, useStreamEvent } from "@/lib/admin/session";
import { useLoad } from "@/lib/admin/useLoad";
import type { Admin, CreatedAdmin, LimitItem, Role, Tier } from "@/lib/admin/types";
import { RequirePerm } from "../AdminShell";
import {
  Badge,
  css as s,
  cx,
  Empty,
  ErrorBox,
  GuardedButton,
  OPERATION,
  PageHead,
  Pager,
  Panel,
  PERIOD,
  ReasonDialog,
  Skeleton,
  StatusBadge,
  TIER,
  useCursorPager,
  useToast,
} from "../ui";

// ============================== Límites ==============================
export function LimitsView() {
  const { can, api } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad((a) => a.limitsConfig(), []);
  const [editing, setEditing] = useState<{ tier: Tier; values: Record<string, string> } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const allowed = can("limits:write");

  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Panel title="Límites"><Skeleton rows={6} /></Panel>;
  if (!data || !api) return null;

  const k = (i: LimitItem) => `${i.operation}:${i.period}`;
  const editingItems = editing ? data.tiers.find((t) => t.tier === editing.tier)?.items ?? [] : [];

  return (
    <>
      <PageHead title="Configuración de límites" sub="Límites por nivel en COP equivalente. Periodos en hora de Bogotá. Los overrides por cliente se editan en su ficha." />
      <div className={s.grid2}>
        {data.tiers.map((t) => {
          const isEditing = editing?.tier === t.tier;
          return (
            <Panel
              key={t.tier}
              title={`Nivel ${TIER[t.tier]}`}
              actions={
                isEditing ? (
                  <>
                    <button type="button" className={cx(s.btn, s.btnSm)} onClick={() => setEditing(null)}>
                      Cancelar
                    </button>
                    <button type="button" id={`limits-save-${t.tier}`} className={cx(s.btn, s.btnSm, s.btnPrimary)} onClick={() => setSaveOpen(true)}>
                      Guardar…
                    </button>
                  </>
                ) : (
                  <GuardedButton
                    allowed={allowed}
                    className={s.btnSm}
                    id={`limits-edit-${t.tier}`}
                    onClick={() => setEditing({ tier: t.tier, values: Object.fromEntries(t.items.map((i) => [k(i), String(i.limitMinor / 100)])) })}
                  >
                    Editar
                  </GuardedButton>
                )
              }
              bodyless
            >
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Operación</th>
                    <th>Periodo</th>
                    <th className={s.right}>Límite</th>
                  </tr>
                </thead>
                <tbody>
                  {t.items.map((i) => (
                    <tr key={k(i)}>
                      <td>{OPERATION[i.operation]}</td>
                      <td>{PERIOD[i.period]}</td>
                      <td className={s.right}>
                        {isEditing && editing ? (
                          <input
                            className={s.input}
                            style={{ width: 160, textAlign: "right" }}
                            inputMode="numeric"
                            value={editing.values[k(i)]}
                            onChange={(e) => setEditing({ ...editing, values: { ...editing.values, [k(i)]: e.target.value } })}
                            aria-label={`${OPERATION[i.operation]} ${PERIOD[i.period]} en COP`}
                          />
                        ) : (
                          <span className={s.num}>{formatMinor(i.limitMinor, "COP")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          );
        })}
      </div>
      <ReasonDialog
        open={saveOpen && !!editing}
        title={editing ? `Guardar límites · nivel ${TIER[editing.tier]}` : "Guardar límites"}
        description="Aplica a todos los clientes del nivel que no tengan override."
        confirmLabel="Guardar"
        onClose={() => setSaveOpen(false)}
        onConfirm={async (reason) => {
          if (!editing) return;
          const next = editingItems.map((i) => {
            const v = parseToMinor(editing.values[k(i)] ?? "");
            if (v === null) throw new Error(`Valor inválido en ${OPERATION[i.operation]} ${PERIOD[i.period]}.`);
            return { operation: i.operation, period: i.period, limitMinor: v };
          });
          await api.updateLimitsConfig(editing.tier, next, reason);
          setEditing(null);
          toast("Límites actualizados");
          void reload(true);
        }}
      />
    </>
  );
}

// ============================== Proveedores ==============================
export function ProvidersView() {
  const toast = useToast();
  const { api, can } = useSession();
  const { data, setData, error, loading, reload } = useLoad((a) => a.providers(), []);
  const [checking, setChecking] = useState<string | null>(null);
  useStreamEvent(["provider.status"], (e) => {
    if (e.type !== "provider.status") return;
    setData((d) => (d ? { items: d.items.map((p) => (p.id === e.data.id ? e.data : p)) } : d));
  });

  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Panel title="Conexiones"><Skeleton rows={5} /></Panel>;
  if (!data || !api) return null;

  return (
    <>
      <PageHead title="Conexiones con proveedores" sub="Estado de las integraciones: Bre-B, KYC, AML, socio BRL y OTP." />
      <Panel bodyless>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Modo</th>
                <th>Estado</th>
                <th className={s.right}>Latencia</th>
                <th className={s.right}>Éxito 24 h</th>
                <th>Último chequeo</th>
                <th>Último error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className={cx(s.mono, s.faint)}>{p.id}</div>
                  </td>
                  <td>{p.mode === "live" ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">Mock</Badge>}</td>
                  <td>
                    <StatusBadge value={p.status} />
                  </td>
                  <td className={cx(s.right, s.num, p.latencyMs > 1000 && s.neg)}>{p.latencyMs} ms</td>
                  <td className={cx(s.right, s.num, p.successRate24h < 0.98 && s.neg)}>{pct(p.successRate24h)}</td>
                  <td className={s.faint}>{timeAgo(p.lastCheckAt)}</td>
                  <td className={s.muted} style={{ maxWidth: 280 }}>
                    {p.lastError ?? <span className={s.faint}>—</span>}
                  </td>
                  <td className={s.right}>
                    <GuardedButton
                      allowed={can("providers:check")}
                      className={s.btnSm}
                      disabled={checking === p.id}
                      onClick={async () => {
                        setChecking(p.id);
                        try {
                          const r = await api.checkProvider(p.id);
                          setData((d) => (d ? { items: d.items.map((x) => (x.id === r.id ? r : x)) } : d));
                          toast(`${r.name}: ${r.status} · ${r.latencyMs} ms`);
                        } catch (ex) {
                          toast(ex instanceof Error ? ex.message : "Error", "bad");
                        } finally {
                          setChecking(null);
                        }
                      }}
                    >
                      {checking === p.id ? "Probando…" : "Probar ahora"}
                    </GuardedButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ============================== Audit log ==============================
export function AuditView() {
  return (
    <RequirePerm perm="audit:read">
      <Audit />
    </RequirePerm>
  );
}

function Audit() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const key = [action, actor, targetType, targetId].join("|");
  const pager = useCursorPager(key);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(
    (a) => a.auditLog({ action, actorId: actor, targetType, targetId, limit: 40, cursor: pager.cursor }),
    [key, pager.cursor],
  );

  return (
    <>
      <PageHead title="Audit log" sub="Registro inmutable de cada acción administrativa, con motivo, antes y después." />
      <Panel bodyless>
        <div className={s.filters}>
          <select className={s.select} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Acción">
            <option value="">Acción: todas</option>
            <option value="customer.">customer.*</option>
            <option value="transaction.">transaction.*</option>
            <option value="beneficiary.">beneficiary.*</option>
            <option value="alert.">alert.*</option>
            <option value="treasury.">treasury.*</option>
            <option value="limits.">limits.*</option>
            <option value="admin.">admin.*</option>
          </select>
          <select className={s.select} value={targetType} onChange={(e) => setTargetType(e.target.value)} aria-label="Tipo de objetivo">
            <option value="">Objetivo: todos</option>
            {["customer", "transaction", "beneficiary", "alert", "device", "treasury", "fx", "limits", "admin"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input className={s.input} placeholder="Actor (id o correo)" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor" />
          <input className={s.input} placeholder="ID del objetivo" value={targetId} onChange={(e) => setTargetId(e.target.value.trim())} aria-label="ID del objetivo" />
        </div>
        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBox message={error} onRetry={() => void reload()} />
          </div>
        ) : loading && !data ? (
          <Skeleton rows={10} />
        ) : !data || data.items.length === 0 ? (
          <Empty>Sin registros.</Empty>
        ) : (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Actor</th>
                    <th>Acción</th>
                    <th>Objetivo</th>
                    <th>Motivo</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <Fragment key={e.id}>
                      <tr className={s.clickRow} onClick={() => setExpanded((x) => (x === e.id ? null : e.id))}>
                        <td className={cx(s.faint, s.num)}>{formatDateTime(e.at)}</td>
                        <td>
                          {e.actor.email}
                          <div className={s.faint} style={{ fontSize: 12 }}>
                            {ROLE_LABEL[e.actor.role]}
                          </div>
                        </td>
                        <td className={s.mono}>{e.action}</td>
                        <td>
                          <span className={s.faint}>{e.targetType}</span>{" "}
                          {e.targetType === "customer" ? (
                            <Link className={s.mono} href={`/admin-portal/customers/?id=${e.targetId}`} onClick={(ev) => ev.stopPropagation()}>
                              {e.targetId}
                            </Link>
                          ) : e.targetType === "transaction" ? (
                            <Link className={s.mono} href={`/admin-portal/transactions/?id=${e.targetId}`} onClick={(ev) => ev.stopPropagation()}>
                              {e.targetId}
                            </Link>
                          ) : (
                            <span className={s.mono}>{e.targetId}</span>
                          )}
                        </td>
                        <td className={s.muted}>{e.reason ?? <span className={s.faint}>—</span>}</td>
                        <td className={cx(s.mono, s.faint)}>{e.ip}</td>
                      </tr>
                      {expanded === e.id ? (
                        <tr key={`${e.id}-x`}>
                          <td colSpan={6}>
                            <div className={s.grid2} style={{ gap: 10 }}>
                              <div>
                                <div className={s.faint} style={{ fontSize: 11.5, marginBottom: 4 }}>
                                  Antes
                                </div>
                                <pre className={s.code}>{JSON.stringify(e.before, null, 2)}</pre>
                              </div>
                              <div>
                                <div className={s.faint} style={{ fontSize: 11.5, marginBottom: 4 }}>
                                  Después
                                </div>
                                <pre className={s.code}>{JSON.stringify(e.after, null, 2)}</pre>
                              </div>
                            </div>
                            <div className={s.faint} style={{ fontSize: 11.5, marginTop: 6 }}>
                              {e.userAgent}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
              label="registros"
            />
          </>
        )}
      </Panel>
    </>
  );
}

// ============================== Usuarios admin ==============================
export function UsersView() {
  return (
    <RequirePerm perm="admins:manage">
      <Users />
    </RequirePerm>
  );
}

type UserDialog =
  | { kind: "create" }
  | { kind: "role"; user: Admin }
  | { kind: "status"; user: Admin }
  | { kind: "reset"; user: Admin }
  | null;

function Users() {
  const { api, admin: me } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad((a) => a.users(), []);
  const [dialog, setDialog] = useState<UserDialog>(null);
  const [form, setForm] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "support" });
  const [newRole, setNewRole] = useState<Role>("viewer");
  const [created, setCreated] = useState<(CreatedAdmin & { reset?: boolean }) | null>(null);

  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <Panel title="Usuarios"><Skeleton rows={6} /></Panel>;
  if (!data || !api) return null;

  return (
    <>
      <PageHead
        title="Usuarios admin"
        sub="Cuentas del equipo CuyPay. Cada usuario usa contraseña + TOTP obligatorio."
        actions={
          <button
            type="button"
            id="users-create"
            className={cx(s.btn, s.btnPrimary)}
            onClick={() => {
              setForm({ email: "", name: "", role: "support" });
              setDialog({ kind: "create" });
            }}
          >
            + Nuevo usuario
          </button>
        }
      />

      {created ? (
        <Panel title={created.reset ? "Credenciales restablecidas: comparte estos datos una sola vez" : "Usuario creado: comparte estos datos una sola vez"} actions={<button type="button" className={cx(s.btn, s.btnSm)} onClick={() => setCreated(null)}>Ocultar</button>}>
          <dl className={s.dl}>
            <dt>Correo</dt>
            <dd>{created.admin.email}</dd>
            <dt>Contraseña temporal</dt>
            <dd className={s.mono}>{created.temporaryPassword}</dd>
            <dt>Enrolar TOTP</dt>
            <dd className={s.mono}>{created.otpauthUrl}</dd>
          </dl>
          <p className={s.hint} style={{ marginTop: 10 }}>
            No se volverán a mostrar. Envíalos por un canal seguro; el usuario deberá cambiar la contraseña al entrar.
          </p>
        </Panel>
      ) : null}

      <Panel bodyless>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Último acceso</th>
                <th>Creado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name} {u.id === me?.id ? <Badge tone="info">Tú</Badge> : null}
                    <div className={s.faint} style={{ fontSize: 12 }}>
                      {u.email}
                    </div>
                  </td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>
                    <StatusBadge value={u.status} />
                  </td>
                  <td className={s.faint}>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Nunca"}</td>
                  <td className={s.faint}>{formatDateTime(u.createdAt)}</td>
                  <td className={s.right}>
                    <span className={s.row} style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <button
                        type="button"
                        className={cx(s.btn, s.btnSm)}
                        disabled={u.id === me?.id}
                        onClick={() => {
                          setNewRole(u.role);
                          setDialog({ kind: "role", user: u });
                        }}
                      >
                        Cambiar rol
                      </button>
                      <button
                        type="button"
                        className={cx(s.btn, s.btnSm, u.status === "active" && s.btnDanger)}
                        disabled={u.id === me?.id}
                        onClick={() => setDialog({ kind: "status", user: u })}
                      >
                        {u.status === "active" ? "Deshabilitar" : "Habilitar"}
                      </button>
                      <button
                        type="button"
                        className={cx(s.btn, s.btnSm)}
                        disabled={u.id === me?.id || u.status !== "active"}
                        title="Nueva contraseña temporal + nuevo TOTP; revoca sus sesiones"
                        onClick={() => setDialog({ kind: "reset", user: u })}
                      >
                        Restablecer acceso
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <ReasonDialog
        open={dialog?.kind === "create"}
        title="Nuevo usuario admin"
        description="Se genera una contraseña temporal y un enlace otpauth:// para enrolar TOTP."
        confirmLabel="Crear usuario"
        canConfirm={/^[^@\s]+@cuypay\.com$/i.test(form.email) && form.name.trim().length > 1}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const r = await api.createUser({ email: form.email.trim(), name: form.name.trim(), role: form.role }, reason);
          setCreated(r);
          toast("Usuario creado");
          void reload(true);
        }}
      >
        <label className={s.field}>
          <span>Nombre</span>
          <input className={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className={s.field}>
          <span>Correo (@cuypay.com)</span>
          <input className={s.input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="nombre@cuypay.com" />
        </label>
        <label className={s.field}>
          <span>Rol</span>
          <select className={s.select} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      </ReasonDialog>

      <ReasonDialog
        open={dialog?.kind === "role"}
        title="Cambiar rol"
        description={dialog?.kind === "role" ? `${dialog.user.name} · rol actual: ${ROLE_LABEL[dialog.user.role]}` : undefined}
        confirmLabel="Guardar rol"
        canConfirm={dialog?.kind === "role" && newRole !== dialog.user.role}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (dialog?.kind !== "role") return;
          await api.updateUser(dialog.user.id, { role: newRole }, reason);
          toast("Rol actualizado");
          void reload(true);
        }}
      >
        <label className={s.field}>
          <span>Nuevo rol</span>
          <select className={s.select} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      </ReasonDialog>

      <ReasonDialog
        open={dialog?.kind === "status"}
        title={dialog?.kind === "status" && dialog.user.status === "active" ? "Deshabilitar usuario" : "Habilitar usuario"}
        description={dialog?.kind === "status" ? dialog.user.email : undefined}
        confirmLabel={dialog?.kind === "status" && dialog.user.status === "active" ? "Deshabilitar" : "Habilitar"}
        danger={dialog?.kind === "status" && dialog.user.status === "active"}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (dialog?.kind !== "status") return;
          await api.updateUser(dialog.user.id, { status: dialog.user.status === "active" ? "disabled" : "active" }, reason);
          toast("Usuario actualizado");
          void reload(true);
        }}
      />

      <ReasonDialog
        open={dialog?.kind === "reset"}
        title="Restablecer credenciales"
        description={
          dialog?.kind === "reset"
            ? `${dialog.user.email} · se genera una contraseña temporal y un nuevo TOTP, y se cierran sus sesiones.`
            : undefined
        }
        confirmLabel="Restablecer"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (dialog?.kind !== "reset") return;
          const r = await api.resetCredentials(dialog.user.id, reason);
          setCreated({ ...r, reset: true });
          toast("Credenciales restablecidas");
          void reload(true);
        }}
      />
    </>
  );
}
