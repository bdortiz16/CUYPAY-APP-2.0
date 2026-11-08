import { pino, type Logger } from 'pino';
import type { AppConfig } from './config.js';
import { systemClock, type Clock } from './lib/clock.js';
import { createMemoryRepositories } from './repositories/memory.js';
import type { Repositories } from './repositories/types.js';
import type { AmlProvider, BrlLiquidityProvider, CoinsendaGateway, KycProvider, OtpSender } from './ports/index.js';
import { MockCoinsendaGateway } from './adapters/coinsenda/mock.js';
import { LiveCoinsendaGateway } from './adapters/coinsenda/live.js';
import { LiveSumsubProvider, MockSumsubProvider } from './adapters/sumsub/provider.js';
import { LiveSartblockProvider, MockAmlProvider } from './adapters/sartblock/provider.js';
import { LiveBrlLiquidityProvider, MockBrlLiquidityProvider } from './adapters/brl/provider.js';
import { MockOtpSender, UnconfiguredOtpSender } from './adapters/otp/sender.js';
import { KeyedMutex, type ServiceDeps } from './services/deps.js';
import { LedgerService } from './services/ledger.js';
import { LimitsService } from './services/limits.js';
import { IdempotencyService } from './services/idempotency.js';
import { AuthService } from './services/auth.js';
import { SignatureService } from './services/signature.js';
import { KycService } from './services/kyc.js';
import { BrebService } from './services/breb.js';
import { BeneficiaryService } from './services/beneficiaries.js';
import { TransferService } from './services/transfers.js';
import { FxService } from './services/fx.js';
import { DepositService } from './services/deposits.js';
import { DeviceService, TransactionService } from './services/feed.js';

/** Rutas de log con secretos/PII que pino debe ocultar. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-cuypay-signature"]',
  'req.headers["x-payload-digest"]',
  'req.headers["x-admin-key"]',
  '*.otpCode',
  '*.code',
  '*.devicePublicKey',
  '*.signature',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.documentNumber',
  '*.privateKey',
  '*.email',
  '*.phone',
];

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'cuypay-backend' },
  });
}

export interface ContainerOverrides {
  clock?: Clock;
  repos?: Repositories;
  logger?: Logger;
  coinsenda?: CoinsendaGateway;
  kyc?: KycProvider;
  aml?: AmlProvider;
  brl?: BrlLiquidityProvider;
  otp?: OtpSender;
}

export function createContainer(config: AppConfig, o: ContainerOverrides = {}) {
  const clock = o.clock ?? systemClock;
  const logger = o.logger ?? createLogger(config);
  const live = config.PROVIDERS_MODE === 'live';

  const coinsenda =
    o.coinsenda ??
    (live
      ? new LiveCoinsendaGateway({
          domain: config.COINSENDA_DOMAIN,
          email: config.COINSENDA_EMAIL!,
          privateKeyPem: config.COINSENDA_PRIVATE_KEY_PEM!,
          brebDepositAccountId: config.COINSENDA_BREB_DEPOSIT_ACCOUNT_ID!,
          copAccountId: config.COINSENDA_COP_ACCOUNT_ID!,
          brebWithdrawProviderId: config.COINSENDA_BREB_WITHDRAW_PROVIDER_ID,
          logger,
        })
      : new MockCoinsendaGateway(clock));
  const kyc =
    o.kyc ??
    (live
      ? new LiveSumsubProvider({ baseUrl: config.SUMSUB_BASE_URL, appToken: config.SUMSUB_APP_TOKEN!, secretKey: config.SUMSUB_SECRET_KEY!, logger })
      : new MockSumsubProvider());
  const aml =
    o.aml ??
    (live ? new LiveSartblockProvider({ baseUrl: config.SARTBLOCK_BASE_URL!, apiKey: config.SARTBLOCK_API_KEY!, logger }) : new MockAmlProvider());
  // TODO(brl-partner): el socio BRL aún no está definido; en modo live se usa el stub que responde PROVIDER_ERROR
  // salvo que se fuerce el mock con BRL_PROVIDER_MODE=mock.
  const brlMode = config.BRL_PROVIDER_MODE ?? config.PROVIDERS_MODE;
  const brl = o.brl ?? (brlMode === 'live' ? new LiveBrlLiquidityProvider() : new MockBrlLiquidityProvider(clock));
  const otp = o.otp ?? (config.NODE_ENV === 'production' ? new UnconfiguredOtpSender() : new MockOtpSender(logger));

  const repos = o.repos ?? createMemoryRepositories();
  const deps: ServiceDeps = { config, repos, clock, logger, coinsenda, kyc, aml, brl, otp };
  const mutex = new KeyedMutex();
  const ledger = new LedgerService(deps);
  const limits = new LimitsService(deps);
  const idempotency = new IdempotencyService(deps);
  const beneficiaries = new BeneficiaryService(deps);

  const services = {
    ledger,
    limits,
    idempotency,
    auth: new AuthService(deps),
    signature: new SignatureService(deps),
    kyc: new KycService(deps),
    breb: new BrebService(deps),
    beneficiaries,
    transfers: new TransferService(deps, ledger, limits, beneficiaries, idempotency, mutex),
    fx: new FxService(deps, ledger, limits, idempotency, mutex),
    deposits: new DepositService(deps, ledger, limits, mutex),
    transactions: new TransactionService(deps),
    devices: new DeviceService(deps),
  };
  return { config, deps, services };
}

export type Container = ReturnType<typeof createContainer>;
