import { z } from 'zod';

/**
 * Configuración del backend, validada con zod.
 * Todas las variables están documentadas en `.env.example`.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-0123456789';

const LimitItemSchema = z.object({
  operation: z.enum(['transfer_out', 'conversion', 'deposit_in']),
  period: z.enum(['daily', 'monthly', 'annual']),
  limitMinor: z.number().int().nonnegative(),
});
export type LimitRule = z.infer<typeof LimitItemSchema>;

const LimitsConfigSchema = z.object({
  basic: z.array(LimitItemSchema),
  full: z.array(LimitItemSchema),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

/**
 * Límites por defecto (COP equivalente, unidades menores = centavos).
 * `full` replica el ejemplo de docs/API_CONTRACT.md §10.
 * TODO(compliance): ajustar a la política SARLAFT y al régimen aplicable (p. ej. depósitos de bajo monto en UVT).
 */
export const DEFAULT_LIMITS: LimitsConfig = {
  basic: [
    { operation: 'transfer_out', period: 'daily', limitMinor: 50_000_000 },
    { operation: 'transfer_out', period: 'monthly', limitMinor: 200_000_000 },
    { operation: 'transfer_out', period: 'annual', limitMinor: 1_000_000_000 },
    { operation: 'conversion', period: 'daily', limitMinor: 50_000_000 },
    { operation: 'conversion', period: 'monthly', limitMinor: 200_000_000 },
    { operation: 'conversion', period: 'annual', limitMinor: 1_000_000_000 },
    { operation: 'deposit_in', period: 'monthly', limitMinor: 200_000_000 },
  ],
  full: [
    { operation: 'transfer_out', period: 'daily', limitMinor: 300_000_000 },
    { operation: 'transfer_out', period: 'monthly', limitMinor: 2_000_000_000 },
    { operation: 'transfer_out', period: 'annual', limitMinor: 15_000_000_000 },
    { operation: 'conversion', period: 'daily', limitMinor: 200_000_000 },
    { operation: 'conversion', period: 'monthly', limitMinor: 2_000_000_000 },
    { operation: 'conversion', period: 'annual', limitMinor: 15_000_000_000 },
    { operation: 'deposit_in', period: 'monthly', limitMinor: 2_000_000_000 },
  ],
};

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PROVIDERS_MODE: z.enum(['mock', 'live']).default('mock'),

    JWT_SECRET: z.string().min(32).optional(),
    JWT_ISSUER: z.string().default('cuypay'),
    JWT_AUDIENCE: z.string().default('cuypay-ios'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SIGNATURE_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(120),
    CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    CORS_ORIGINS: z.string().optional(), // vacío = CORS desactivado
    ADMIN_API_KEY: z.string().min(24).optional(),

    // Coinsenda
    COINSENDA_DOMAIN: z.string().default('bitsenda.com'),
    COINSENDA_EMAIL: z.string().email().optional(),
    COINSENDA_PRIVATE_KEY_PEM: z.string().optional(),
    COINSENDA_BREB_DEPOSIT_ACCOUNT_ID: z.string().optional(),
    COINSENDA_COP_ACCOUNT_ID: z.string().optional(),
    COINSENDA_BREB_WITHDRAW_PROVIDER_ID: z.string().optional(),
    DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),

    // Sumsub
    SUMSUB_APP_TOKEN: z.string().optional(),
    SUMSUB_SECRET_KEY: z.string().optional(),
    SUMSUB_WEBHOOK_SECRET: z.string().optional(),
    SUMSUB_LEVEL_NAME: z.string().default('basic-kyc-level'),
    SUMSUB_BASE_URL: z.string().url().default('https://api.sumsub.com'),
    SUMSUB_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1200),

    // Sartblock (AML)
    SARTBLOCK_BASE_URL: z.string().url().optional(),
    SARTBLOCK_API_KEY: z.string().optional(),

    // Liquidez BRL (socio por definir). Por defecto sigue PROVIDERS_MODE.
    BRL_PROVIDER_MODE: z.enum(['mock', 'live']).optional(),

    // FX / tarifas
    FX_SPREAD_BPS: z.coerce.number().int().min(0).max(5000).default(150),
    CONVERSION_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(100),
    CONVERSION_FEE_MIN_MINOR: z.coerce.number().int().min(0).default(0),
    QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
    TRANSFER_FEE_MINOR: z.coerce.number().int().min(0).default(0),

    LIMITS_CONFIG_JSON: z.string().optional(),
    SEED_DEMO: bool.optional(),
    ENABLE_DEV_ROUTES: bool.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET es obligatorio en producción' });
    }
    if (env.PROVIDERS_MODE === 'live') {
      const required = [
        'COINSENDA_EMAIL',
        'COINSENDA_PRIVATE_KEY_PEM',
        'COINSENDA_BREB_DEPOSIT_ACCOUNT_ID',
        'COINSENDA_COP_ACCOUNT_ID',
        'SUMSUB_APP_TOKEN',
        'SUMSUB_SECRET_KEY',
        'SUMSUB_WEBHOOK_SECRET',
        'SARTBLOCK_BASE_URL',
        'SARTBLOCK_API_KEY',
      ] as const;
      for (const key of required) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} es obligatorio con PROVIDERS_MODE=live` });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<Env, 'JWT_SECRET' | 'LIMITS_CONFIG_JSON' | 'SEED_DEMO' | 'ENABLE_DEV_ROUTES'> {
  JWT_SECRET: string;
  limits: LimitsConfig;
  seedDemo: boolean;
  devRoutes: boolean;
  corsOrigins: string[];
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // Las cadenas vacías se tratan como "no definida".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${msg}`);
  }
  const env = parsed.data;
  const limits = env.LIMITS_CONFIG_JSON
    ? LimitsConfigSchema.parse(JSON.parse(env.LIMITS_CONFIG_JSON))
    : DEFAULT_LIMITS;
  const isProd = env.NODE_ENV === 'production';
  const { LIMITS_CONFIG_JSON: _l, SEED_DEMO, ENABLE_DEV_ROUTES, JWT_SECRET, ...rest } = env;
  return {
    ...rest,
    JWT_SECRET: JWT_SECRET ?? DEV_JWT_SECRET,
    limits,
    seedDemo: SEED_DEMO ?? (env.NODE_ENV === 'development' && env.PROVIDERS_MODE === 'mock'),
    // Las rutas /v1/dev/* nunca se habilitan en producción ni en modo live.
    devRoutes: !isProd && env.PROVIDERS_MODE === 'mock' && (ENABLE_DEV_ROUTES ?? true),
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}
