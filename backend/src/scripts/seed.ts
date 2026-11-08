import type { Container } from '../container.js';
import { MockCoinsendaGateway } from '../adapters/coinsenda/mock.js';
import { MockBrlLiquidityProvider } from '../adapters/brl/provider.js';
import type { Transaction, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';

export const DEMO_PHONE = '+573001234567';

/**
 * Datos demo para la app iOS (solo memoria / modo mock):
 *  - Usuaria Ana Gómez (+573001234567), KYC aprobado (tier full).
 *  - Llave Bre-B @cuypayana123.
 *  - Saldos: COP 1.250.000,00 (con 50.000,00 retenidos en un envío pendiente) y BRL 1.802,21.
 *  - Beneficiario Juan Pérez (3001234567) activo, y movimientos de ejemplo.
 *
 * La app iOS se registra con el teléfono demo (+573001234567, OTP 123456): como el
 * teléfono existe, el registro vincula el nuevo dispositivo (Secure Enclave) a esta usuaria.
 */
export async function seedDemo(container: Container): Promise<User> {
  const { deps, services } = container;
  const { repos, clock } = deps;
  const existing = await repos.users.byPhone(DEMO_PHONE);
  if (existing) return existing;
  if (!(deps.coinsenda instanceof MockCoinsendaGateway)) throw new AppError('INTERNAL_ERROR', 'El seed demo solo funciona en modo mock');
  const gw = deps.coinsenda;

  const base = clock.now().getTime();
  const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000);

  const user: User = {
    id: newId('usr', at(60 * 24 * 20)),
    phone: DEMO_PHONE,
    email: 'ana.gomez@demo.cuypay.com',
    firstName: 'Ana',
    lastName: 'Gómez',
    country: 'CO',
    kycStatus: 'approved',
    tier: 'full',
    createdAt: at(60 * 24 * 20),
    updatedAt: at(60 * 24 * 19),
  };
  await repos.users.create(user);
  await repos.kyc.upsert({
    userId: user.id,
    provider: 'sumsub',
    applicantId: 'mock_applicant_demo',
    levelName: deps.config.SUMSUB_LEVEL_NAME,
    status: 'approved',
    reviewAnswer: 'GREEN',
    rejectLabels: [],
    rejectType: null,
    updatedAt: at(60 * 24 * 19),
  });

  const created = await gw.createBrebKey({ alias: '@cuypayana123', holderName: 'Ana Gómez', userRef: user.id });
  const key = {
    id: newId('brk', at(60 * 24 * 19)),
    userId: user.id,
    alias: created.alias,
    status: 'active' as const,
    holderName: 'Ana Gómez',
    providerKeyId: created.providerKeyId,
    createdAt: at(60 * 24 * 19),
  };
  await repos.brebKeys.create(key);

  const mkTxn = (p: Partial<Transaction> & Pick<Transaction, 'type' | 'direction' | 'currency' | 'amountMinor' | 'title' | 'subtitle'>, minutesAgo: number): Transaction => ({
    id: newId('txn', at(minutesAgo)),
    userId: user.id,
    feeMinor: 0n,
    status: 'completed',
    description: null,
    conversion: null,
    beneficiaryId: null,
    quoteId: null,
    providerRef: null,
    flagged: false,
    failureReason: null,
    createdAt: at(minutesAgo),
    updatedAt: at(minutesAgo),
    ...p,
  });

  // Depósitos entrantes (suman 2.700.000,00 COP).
  const deposits: [bigint, string, number][] = [
    [90_000_000n, 'María Gómez', 60 * 24 * 15],
    [150_000_000n, 'Carlos Ramírez', 60 * 24 * 10],
    [30_000_000n, 'Laura Martínez', 60 * 24 * 3],
  ];
  for (const [amount, payer, ago] of deposits) {
    const t = mkTxn({ type: 'deposit', direction: 'in', currency: 'COP', amountMinor: amount, title: payer, subtitle: `Bre-B · ${key.alias}`, providerRef: `dep_seed_${ago}` }, ago);
    // Registro equivalente en el mock de Coinsenda para que la conciliación del portal admin cuadre.
    gw.deposits.push({ id: `dep_seed_${ago}`, providerKeyId: key.providerKeyId, amountMinor: amount, currency: 'COP', state: 'accepted', payerName: payer, createdAt: at(ago), raw: { mock: true, seed: true } });
    await repos.processedDeposits.tryInsert({ providerDepositId: `dep_seed_${ago}`, userId: user.id, transactionId: t.id, processedAt: at(ago), note: null });
    await repos.transactions.create(t);
    await services.ledger.credit(user.id, 'COP', amount, t.id);
    await repos.limitUsage.add({ id: newId('lmu', t.createdAt), userId: user.id, operation: 'deposit_in', amountMinor: amount, transactionId: t.id, occurredAt: t.createdAt, voidedAt: null });
  }

  // Beneficiario activo.
  const holder = (await gw.resolveBrebAlias('3001234567'))!;
  const amlId = newId('aml', at(60 * 24 * 9));
  const benId = newId('ben', at(60 * 24 * 9));
  await repos.aml.create({ id: amlId, userId: user.id, subjectType: 'beneficiary', subjectId: benId, provider: 'sartblock', result: 'clear', referenceId: 'sb_mock_demo', checkedAt: at(60 * 24 * 9), raw: { mock: true } });
  const wa = await gw.addWithdrawAccount({ holder, label: `cuypay:${user.id}:${benId}` });
  await repos.beneficiaries.create({
    id: benId,
    userId: user.id,
    alias: '3001234567',
    holderName: 'Juan Pérez',
    documentType: 'CC',
    documentNumber: holder.documentNumber,
    nickname: 'Juan',
    bankName: 'Bancolombia',
    status: 'active',
    amlCheckId: amlId,
    providerWithdrawAccountId: wa.withdrawAccountId,
    createdAt: at(60 * 24 * 9),
    deletedAt: null,
  });

  // Envío completado.
  const sentWd = await gw.createWithdraw({ withdrawAccountId: wa.withdrawAccountId, amountMinor: 5_000_000n, reference: 'seed_sent_1' });
  gw.setWithdrawState(sentWd.withdrawId, 'accepted');
  const sent = mkTxn({ type: 'transfer', direction: 'out', currency: 'COP', amountMinor: 5_000_000n, title: 'Juan', subtitle: 'Bre-B · 3001234567', beneficiaryId: benId, providerRef: sentWd.withdrawId }, 60 * 24 * 2);
  await repos.transactions.create(sent);
  await services.ledger.hold(user.id, 'COP', 5_000_000n, sent.id);
  await services.ledger.settleHold(user.id, 'COP', 5_000_000n, 0n, sent.id);
  await repos.limitUsage.add({ id: newId('lmu', sent.createdAt), userId: user.id, operation: 'transfer_out', amountMinor: 5_000_000n, transactionId: sent.id, occurredAt: sent.createdAt, voidedAt: null });

  // Conversión COP → BRL histórica: (1.400.000,00 − 14.000,00) × 0.0013003 = BRL 1.802,21 (floor).
  const rateScaled = 13_003_000n; // 0.0013003 escalado 1e10
  const convFrom = 140_000_000n;
  const convFee = 1_400_000n;
  const convTo = ((convFrom - convFee) * rateScaled) / 10n ** 10n; // 180_221
  const conv = mkTxn(
    {
      type: 'conversion',
      direction: 'out',
      currency: 'COP',
      amountMinor: convFrom,
      feeMinor: convFee,
      title: 'COP → BRL',
      subtitle: 'Conversión',
      conversion: { fromCurrency: 'COP', fromAmountMinor: convFrom, toCurrency: 'BRL', toAmountMinor: convTo, rateScaled },
      providerRef: 'brl_seed_1',
    },
    60 * 24,
  );
  if (deps.brl instanceof MockBrlLiquidityProvider) deps.brl.executions.push({ reference: conv.id, fromAmountMinor: convFrom - convFee, toAmountMinor: convTo });
  await repos.transactions.create(conv);
  await services.ledger.convert(user.id, { from: 'COP', to: 'BRL', fromAmount: convFrom, fee: convFee, toAmount: convTo }, conv.id);
  await repos.limitUsage.add({ id: newId('lmu', conv.createdAt), userId: user.id, operation: 'conversion', amountMinor: convFrom, transactionId: conv.id, occurredAt: conv.createdAt, voidedAt: null });
  // COP: 2.700.000 − 50.000 − 1.400.000 = 1.250.000,00

  // Envío pendiente (retiene 50.000,00 COP).
  const pending = mkTxn({ type: 'transfer', direction: 'out', currency: 'COP', amountMinor: 5_000_000n, status: 'pending', title: 'Juan', subtitle: 'Bre-B · 3001234567', beneficiaryId: benId }, 30);
  const w = await gw.createWithdraw({ withdrawAccountId: wa.withdrawAccountId, amountMinor: 5_000_000n, reference: pending.id });
  pending.providerRef = w.withdrawId;
  await repos.transactions.create(pending);
  await services.ledger.hold(user.id, 'COP', 5_000_000n, pending.id);
  await repos.limitUsage.add({ id: newId('lmu', pending.createdAt), userId: user.id, operation: 'transfer_out', amountMinor: 5_000_000n, transactionId: pending.id, occurredAt: pending.createdAt, voidedAt: null });

  deps.logger.info({ userId: user.id, alias: key.alias }, 'demo data seeded (phone +573001234567, OTP 123456)');
  return user;
}
