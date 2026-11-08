import { presentTransaction, type TransactionJson } from '../domain/presenters.js';
import type { Transaction, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { WithdrawState } from '../ports/index.js';
import type { BeneficiaryService } from './beneficiaries.js';
import type { KeyedMutex, ServiceDeps } from './deps.js';
import type { IdempotencyService } from './idempotency.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService } from './ledger.js';
import type { LimitsService } from './limits.js';

const FINAL_OK: WithdrawState[] = ['accepted'];
const FINAL_FAIL: WithdrawState[] = ['rejected', 'canceled', 'failed'];

/** Envíos Bre-B (salida COP). */
export class TransferService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly idem: IdempotencyService,
    private readonly mutex: KeyedMutex,
  ) {}

  private fee(): bigint {
    return BigInt(this.d.config.TRANSFER_FEE_MINOR);
  }

  private async activeBeneficiary(userId: string, beneficiaryId: string) {
    const b = await this.beneficiaries.getOwned(userId, beneficiaryId);
    if (b.status !== 'active' || !b.providerWithdrawAccountId) {
      throw new AppError('BENEFICIARY_NOT_ACTIVE', 'El beneficiario no está activo', { status: b.status });
    }
    return b;
  }

  async preview(user: User, beneficiaryId: string, amountMinor: number) {
    requireKycApproved(user);
    await this.activeBeneficiary(user.id, beneficiaryId);
    const amount = BigInt(amountMinor);
    const fee = this.fee();
    await this.limits.assertWithin(user, 'transfer_out', amount);
    const wallet = await this.ledger.wallet(user.id, 'COP');
    if (wallet.availableMinor < amount + fee) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente', { availableMinor: Number(wallet.availableMinor) });
    }
    return { amount, fee, total: amount + fee, limits: await this.limits.snapshot(user) };
  }

  async execute(
    user: User,
    input: { beneficiaryId: string; amountMinor: number; description?: string; idempotencyKey: string },
  ): Promise<{ status: number; body: TransactionJson }> {
    requireKycApproved(user);
    return this.mutex.run(user.id, () =>
      this.idem.run(user.id, 'transfer', input.idempotencyKey, input, async () => {
        const txn = await this.doExecute(user, input);
        return { status: 201, body: presentTransaction(txn) };
      }),
    );
  }

  private async doExecute(
    user: User,
    input: { beneficiaryId: string; amountMinor: number; description?: string; idempotencyKey: string },
  ): Promise<Transaction> {
    const b = await this.activeBeneficiary(user.id, input.beneficiaryId);
    const amount = BigInt(input.amountMinor);
    const fee = this.fee();
    const total = amount + fee;
    await this.limits.assertWithin(user, 'transfer_out', amount);
    const wallet = await this.ledger.wallet(user.id, 'COP');
    if (wallet.availableMinor < total) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente', { availableMinor: Number(wallet.availableMinor) });
    }

    const now = this.d.clock.now();
    const txn: Transaction = {
      id: newId('txn', now),
      userId: user.id,
      type: 'transfer',
      direction: 'out',
      currency: 'COP',
      amountMinor: amount,
      feeMinor: fee,
      status: 'pending',
      title: b.nickname ?? b.holderName,
      subtitle: `Bre-B · ${b.alias}`,
      description: input.description?.trim() || null,
      conversion: null,
      beneficiaryId: b.id,
      quoteId: null,
      providerRef: null,
      flagged: false,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.transactions.create(txn);
    await this.ledger.hold(user.id, 'COP', total, txn.id);
    await this.limits.record(user.id, 'transfer_out', amount, txn.id);

    try {
      const w = await this.d.coinsenda.createWithdraw({ withdrawAccountId: b.providerWithdrawAccountId!, amountMinor: amount, reference: txn.id });
      txn.providerRef = w.withdrawId;
      await this.d.repos.transactions.update(txn);
      const confirmed = await this.d.coinsenda.confirmWithdraw(w.withdrawId);
      await this.applyWithdrawState(txn, confirmed.state);
    } catch (err) {
      // Si Coinsenda no confirmó el retiro: se revierte la retención y se anula el uso de límites.
      // TODO(coinsenda): si createWithdraw tuvo éxito pero confirm falló por red, consultar el retiro antes de revertir.
      await this.fail(txn, isAppError(err) ? err.message : 'provider_error');
      this.d.logger.error({ txnId: txn.id, err: (err as Error).message }, 'transfer failed at provider');
      throw new AppError('PROVIDER_ERROR', 'No se pudo completar el envío con el proveedor', {
        transactionId: txn.id,
        provider: 'coinsenda',
      });
    }
    return txn;
  }

  /** Aplica el estado del retiro en Coinsenda a la transacción. */
  async applyWithdrawState(txn: Transaction, state: WithdrawState): Promise<void> {
    if (txn.status !== 'pending') return;
    if (FINAL_OK.includes(state)) {
      await this.ledger.settleHold(txn.userId, txn.currency, txn.amountMinor, txn.feeMinor, txn.id);
      txn.status = 'completed';
      txn.updatedAt = this.d.clock.now();
      await this.d.repos.transactions.update(txn);
    } else if (FINAL_FAIL.includes(state)) {
      await this.fail(txn, `withdraw_${state}`);
    }
  }

  private async fail(txn: Transaction, reason: string): Promise<void> {
    await this.ledger.releaseHold(txn.userId, txn.currency, txn.amountMinor + txn.feeMinor, txn.id);
    await this.limits.voidFor(txn.id);
    txn.status = 'failed';
    txn.failureReason = reason;
    txn.updatedAt = this.d.clock.now();
    await this.d.repos.transactions.update(txn);
  }

  /** Job: consulta en Coinsenda los envíos que siguen pendientes. */
  async syncPending(): Promise<number> {
    let changed = 0;
    for (const txn of await this.d.repos.transactions.listPendingTransfers()) {
      if (!txn.providerRef) continue;
      try {
        const w = await this.d.coinsenda.getWithdraw(txn.providerRef);
        if (!w) continue;
        await this.mutex.run(txn.userId, async () => {
          const fresh = await this.d.repos.transactions.byId(txn.id);
          if (fresh && fresh.status === 'pending') {
            await this.applyWithdrawState(fresh, w.state);
            if (fresh.status !== 'pending') changed++;
          }
        });
      } catch (err) {
        this.d.logger.warn({ txnId: txn.id, err: (err as Error).message }, 'withdraw sync failed');
      }
    }
    return changed;
  }
}
