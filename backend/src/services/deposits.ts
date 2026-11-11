import type { Transaction } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import type { CoinsendaDeposit } from '../ports/index.js';
import type { KeyedMutex, ServiceDeps } from './deps.js';
import type { LedgerService } from './ledger.js';
import type { LimitsService } from './limits.js';
import { getCustomerControl } from './runtime-config.js';

/**
 * Ingesta de depósitos Bre-B: sondea Coinsenda (`__get__deposits`, 200 más recientes),
 * atribuye cada depósito al usuario por su llave (deposit_provider_id), deduplica por
 * id de depósito del proveedor y acredita el bolsillo COP.
 *
 * Los depósitos no se pueden rechazar (el dinero ya llegó): si superan el límite
 * deposit_in se acreditan igual pero se marcan (`flagged`) para cumplimiento.
 */
const BREB_WATCH_TTL_MS = 50_000;

export class DepositService {
  private lastPollAtMs = 0;
  private inflightPoll: Promise<{ credited: number; skipped: number }> | null = null;
  private readonly keyWatchedAt = new Map<string, number>();

  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly mutex: KeyedMutex,
  ) {}

  private async renewActiveBrebWatches(): Promise<void> {
    if (!this.d.coinsenda.subscribeBrebDeposits) return;
    try {
      const activeKeys = await this.d.repos.brebKeys.listActive();
      const nowMs = Date.now();
      const due = activeKeys.filter(
        (k) => k.providerKeyId && nowMs - (this.keyWatchedAt.get(k.providerKeyId) ?? 0) >= BREB_WATCH_TTL_MS,
      );
      if (due.length === 0) return;
      await Promise.all(
        due.map(async (k) => {
          this.keyWatchedAt.set(k.providerKeyId, nowMs);
          try {
            await this.d.coinsenda.subscribeBrebDeposits!(k.providerKeyId);
          } catch {
            this.keyWatchedAt.delete(k.providerKeyId);
          }
        }),
      );
    } catch {
      // Mejor esfuerzo
    }
  }

  async poll(): Promise<{ credited: number; skipped: number }> {
    if (this.inflightPoll) return this.inflightPoll;
    const run = (async () => {
      await this.renewActiveBrebWatches();
      const deposits = await this.d.coinsenda.listDeposits();
      this.lastPollAtMs = Date.now();
      let credited = 0;
      let skipped = 0;
      // Del más viejo al más nuevo para que el feed quede en orden.
      for (const dep of [...deposits].reverse()) {
        const r = await this.ingest(dep);
        if (r) credited++;
        else skipped++;
      }
      return { credited, skipped };
    })();
    this.inflightPoll = run;
    try {
      return await run;
    } finally {
      if (this.inflightPoll === run) this.inflightPoll = null;
    }
  }

  /** Sondeo oportunista acotado en tiempo cuando la app consulta saldos/movimientos en vivo. */
  async pollIfStale(minIntervalMs = 4_000, maxWaitMs = 1_500): Promise<void> {
    if (Date.now() - this.lastPollAtMs < minIntervalMs) return;
    const task = this.poll().catch((err) => {
      this.d.logger.warn({ err: (err as Error).message }, 'opportunistic deposit poll failed');
    });
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, maxWaitMs);
        t.unref?.();
      }),
    ]);
  }

  /** Procesa un depósito; devuelve la transacción creada o null si se omitió. */
  async ingest(dep: CoinsendaDeposit): Promise<Transaction | null> {
    if (dep.state !== 'accepted') return null;
    const prev = await this.d.repos.processedDeposits.get(dep.id);
    if (prev && prev.transactionId) return null;
    let key = dep.providerKeyId ? await this.d.repos.brebKeys.byProviderKeyId(dep.providerKeyId) : null;
    const now = this.d.clock.now();
    if (!key && dep.providerKeyId) {
      const allUsers = await this.d.repos.users.listAll();
      const singleUser = allUsers.length === 1 ? allUsers[0] : null;
      if (singleUser) {
        const recoveredKey = {
          id: newId('brk', now),
          userId: singleUser.id,
          alias: `@breb_${dep.providerKeyId.slice(-8)}`,
          status: 'replaced' as const,
          holderName: `${singleUser.firstName} ${singleUser.lastName}`.trim(),
          providerKeyId: dep.providerKeyId,
          createdAt: now,
        };
        await this.d.repos.brebKeys.create(recoveredKey);
        key = recoveredKey;
        this.d.logger.info({ providerKeyId: dep.providerKeyId, userId: singleUser.id }, 'recovered deposit provider mapping to user');
      }
    }
    if (!key) {
      // Depósito sin llave de usuario conocida: se registra para conciliación manual.
      const inserted = await this.d.repos.processedDeposits.tryInsert({
        providerDepositId: dep.id,
        userId: null,
        transactionId: null,
        processedAt: now,
        note: 'unmatched_breb_key',
      });
      if (inserted) this.d.logger.warn({ depositId: dep.id }, 'unmatched deposit (needs reconciliation)');
      return null;
    }
    return this.mutex.run(key.userId, async () => {
      const user = await this.d.repos.users.byId(key.userId);
      if (!user) return null;
      const txnId = newId('txn', now);
      // Dedupe atómico: si otro proceso ya lo tomó, no se acredita dos veces.
      const fresh = await this.d.repos.processedDeposits.tryInsert({
        providerDepositId: dep.id,
        userId: user.id,
        transactionId: txnId,
        processedAt: now,
        note: null,
      });
      if (!fresh) return null;
      const exceeded = await this.limits.firstExceeded(user, 'deposit_in', dep.amountMinor);
      const txn: Transaction = {
        id: txnId,
        userId: user.id,
        type: 'deposit',
        direction: 'in',
        currency: 'COP',
        amountMinor: dep.amountMinor,
        feeMinor: 0n,
        status: 'completed',
        title: dep.payerName?.trim() || 'Depósito Bre-B',
        subtitle: `Bre-B · ${key.alias}`,
        description: null,
        conversion: null,
        beneficiaryId: null,
        quoteId: null,
        providerRef: dep.id,
        flagged: Boolean(exceeded),
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.transactions.create(txn);
      await this.ledger.credit(user.id, 'COP', dep.amountMinor, txn.id);
      await this.limits.record(user.id, 'deposit_in', dep.amountMinor, txn.id);
      const control = await getCustomerControl(this.d, user.id);
      if (control.status === 'frozen') {
        // Cuenta congelada por cumplimiento: el dinero entra pero queda retenido hasta descongelar.
        await this.ledger.hold(user.id, 'COP', dep.amountMinor, txn.id);
        control.heldDepositTxnIds.push(txn.id);
        control.updatedAt = now;
        await this.d.repos.customerControls.upsert(control);
        this.d.logger.warn({ userId: user.id, txnId }, 'deposit to frozen account held');
      }
      await this.d.events.publish({ type: 'transaction.created', txn });
      if (exceeded) {
        // TODO(compliance): alerta al oficial de cumplimiento / posible ROS UIAF; evaluar bloqueo de la llave.
        this.d.logger.warn({ userId: user.id, txnId, period: exceeded.period }, 'deposit_in limit exceeded (flagged)');
      }
      return txn;
    });
  }
}
