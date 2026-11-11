import { randomUUID } from 'node:crypto';
import type { Clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import type { BrebAliasHolder, CoinsendaDeposit, CoinsendaGateway, WithdrawState } from '../../ports/index.js';
import type { Currency } from '../../domain/types.js';

/**
 * Coinsenda simulado. Directorio Bre-B en memoria con llaves de ejemplo:
 *  - 3001234567      → Juan Pérez (Bancolombia)
 *  - @mariarevision  → María Revision (AML mock → review)
 *  - @pedrobloqueado → Pedro Bloqueado (AML mock → hit)
 * Las llaves creadas por usuarios de CuyPay también quedan en el directorio.
 */
export class MockCoinsendaGateway implements CoinsendaGateway {
  readonly directory = new Map<string, BrebAliasHolder>();
  readonly deposits: CoinsendaDeposit[] = [];
  readonly withdraws = new Map<string, { state: WithdrawState; withdrawAccountId: string; amountMinor: bigint }>();
  readonly withdrawAccounts = new Map<string, { holder: BrebAliasHolder; visible: boolean }>();
  /** Estado al que pasa un retiro al confirmarse (tests pueden cambiarlo a 'pending'). */
  confirmResultState: WithdrawState = 'accepted';
  /** Si es true, el próximo createWithdraw falla (simula caída del proveedor). */
  failNextWithdraw = false;
  /** Ajuste manual del saldo (tests de conciliación / cobertura). */
  balanceAdjustmentMinor = 0n;
  /** Si es true, el health check falla (simula caída). */
  down = false;

  constructor(private readonly clock: Clock) {
    const add = (alias: string, firstName: string, lastName: string, doc: string, bank: string) =>
      this.directory.set(alias, {
        alias,
        firstName,
        lastName,
        documentType: 'CC',
        documentNumber: doc,
        bankName: bank,
        raw: { mock: true },
      });
    add('3001234567', 'Juan', 'Pérez', '1023454321', 'Bancolombia');
    add('3109876543', 'Camila', 'Rojas', '52987654', 'Davivienda');
    add('@mariarevision', 'María', 'Revision', '1098765432', 'Nequi');
    add('@pedrobloqueado', 'Pedro', 'Bloqueado', '79123456', 'Banco de Bogotá');
  }

  async createBrebKey(input: { alias: string; holderName: string; userRef: string }) {
    if (this.directory.has(input.alias)) throw new AppError('BREB_ALIAS_TAKEN', 'La llave ya está registrada');
    const [firstName = input.holderName, ...rest] = input.holderName.split(' ');
    this.directory.set(input.alias, {
      alias: input.alias,
      firstName,
      lastName: rest.join(' '),
      documentType: 'CC',
      documentNumber: '0000000000',
      bankName: 'CuyPay',
      raw: { mock: true, userRef: input.userRef },
    });
    return { providerKeyId: `dp_mock_${randomUUID()}`, alias: input.alias, status: 'active' as const, raw: { mock: true } };
  }

  async resolveBrebAlias(alias: string) {
    return this.directory.get(alias) ?? null;
  }

  async addWithdrawAccount(input: { holder: BrebAliasHolder; label: string }) {
    const id = `wa_mock_${randomUUID()}`;
    this.withdrawAccounts.set(id, { holder: input.holder, visible: true });
    return { withdrawAccountId: id, raw: { mock: true } };
  }

  async hideWithdrawAccount(id: string) {
    const wa = this.withdrawAccounts.get(id);
    if (wa) wa.visible = false;
  }

  async createWithdraw(input: { withdrawAccountId: string; amountMinor: bigint; reference: string }) {
    if (this.failNextWithdraw) {
      this.failNextWithdraw = false;
      throw new AppError('PROVIDER_ERROR', 'Coinsenda (mock) rechazó el retiro', { provider: 'coinsenda' });
    }
    const id = `wd_mock_${randomUUID()}`;
    this.withdraws.set(id, { state: 'pending', withdrawAccountId: input.withdrawAccountId, amountMinor: input.amountMinor });
    return { withdrawId: id, state: 'pending' as const, raw: { mock: true } };
  }

  async confirmWithdraw(withdrawId: string) {
    const w = this.withdraws.get(withdrawId);
    if (!w) throw new AppError('PROVIDER_ERROR', 'Retiro inexistente (mock)');
    w.state = this.confirmResultState;
    return { state: w.state, raw: { mock: true } };
  }

  async getWithdraw(withdrawId: string) {
    const w = this.withdraws.get(withdrawId);
    return w ? { state: w.state, raw: { mock: true } } : null;
  }

  /** Cambia el estado de un retiro (simula que Coinsenda lo aceptó o rechazó). */
  setWithdrawState(withdrawId: string, state: WithdrawState) {
    const w = this.withdraws.get(withdrawId);
    if (w) w.state = state;
  }

  /** Saldo simulado = depósitos aceptados − retiros aceptados (+ ajuste). */
  async getBalance() {
    if (this.down) throw new AppError('PROVIDER_ERROR', 'Coinsenda (mock) caído', { provider: 'coinsenda' });
    let bal = this.balanceAdjustmentMinor;
    for (const d of this.deposits) if (d.state === 'accepted' && d.currency === 'COP') bal += d.amountMinor;
    for (const w of this.withdraws.values()) if (w.state === 'accepted') bal -= w.amountMinor;
    return { currency: 'COP' as const, balanceMinor: bal, asOf: this.clock.now() };
  }

  async healthCheck() {
    if (this.down) throw new AppError('PROVIDER_ERROR', 'Coinsenda (mock) caído', { provider: 'coinsenda' });
  }

  async listDeposits() {
    return [...this.deposits].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 200);
  }

  async updateBrebKeyStatus(providerKeyId: string, status: 'active' | 'blocked') {
    // Simulado
  }

  async cancelBrebKey(providerKeyId: string) {
    // Simulado: cancela y libera el alias
    for (const [alias, holder] of this.directory.entries()) {
      if ((holder.raw as any)?.userRef === providerKeyId) {
        this.directory.delete(alias);
      }
    }
  }

  // ── Tarjetas ──
  async issueCard(input: {
    userId: string;
    holderName: string;
    email: string;
    currency: Currency;
    label?: string;
    holder?: { existingCardHolderId?: string | null; firstName: string; lastName: string; email?: string; phone?: string };
  }) {
    const cardId = `crd_cs_${randomUUID().slice(0, 8)}`;
    const contactKey = `${input.holder?.email ?? input.email}:${input.holder?.phone ?? ''}`
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8);
    const holderId = input.holder?.existingCardHolderId ?? `ch_mock_${input.userId}_${contactKey}`;
    const resolvedName = input.holder ? `${input.holder.firstName} ${input.holder.lastName}`.trim() : input.holderName;
    return {
      providerCardId: cardId,
      providerCardHolderId: holderId,
      holderName: resolvedName,
      ledgerAccountId: `acc_card_${randomUUID().slice(0, 8)}`,
      lastFour: '4242',
      brand: 'Mastercard',
      status: 'active' as const,
      raw: { mock: true, ...input },
    };
  }

  async getCardLookUrl(providerCardId: string, _providerCardHolderId?: string) {
    return { url: `https://cards.coinsenda.com/look/mock?card=${providerCardId}` };
  }

  async updateCardWorkingState(providerCardId: string, state: 'active' | 'frozen' | 'canceled') {
    // Simulado
  }

  async updateCardLabel(providerCardId: string, label: string) {
    // Simulado
  }

  async tokenizeApplePay(input: {
    providerCardId: string;
    certificates: string[];
    nonce: string;
    nonceSignature: string;
  }) {
    return {
      activationData: Buffer.from(`mock_activation_${input.providerCardId}`).toString('base64'),
      encryptedPassData: Buffer.from('mock_encrypted_pass_data').toString('base64'),
      ephemeralPublicKey: Buffer.from('mock_ephemeral_public_key').toString('base64'),
    };
  }

  /** Simula un depósito Bre-B entrante a una llave. */
  simulateDeposit(input: { providerKeyId: string; amountMinor: bigint; payerName?: string; id?: string }): CoinsendaDeposit {
    const dep: CoinsendaDeposit = {
      id: input.id ?? `dep_mock_${randomUUID()}`,
      providerKeyId: input.providerKeyId,
      amountMinor: input.amountMinor,
      currency: 'COP',
      state: 'accepted',
      payerName: input.payerName ?? null,
      createdAt: this.clock.now(),
      raw: { mock: true },
    };
    this.deposits.push(dep);
    return dep;
  }
}
