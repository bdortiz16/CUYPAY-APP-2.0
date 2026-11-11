import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Configuración del backend, validada con zod.
 * Todas las variables están documentadas en `.env.example`.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-0123456789';

export const LimitItemSchema = z.object({
  operation: z.enum(['transfer_out', 'conversion', 'deposit_in']),
  period: z.enum(['daily', 'monthly', 'annual']),
  limitMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LimitRule = z.infer<typeof LimitItemSchema>;

export const LimitsConfigSchema = z.object({
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
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
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
    DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),

    // Sumsub
    SUMSUB_APP_TOKEN: z.string().optional(),
    SUMSUB_SECRET_KEY: z.string().optional(),
    SUMSUB_WEBHOOK_SECRET: z.string().optional(),
    SUMSUB_LEVEL_NAME: z.string().default('idv-and-phone-verification'),
    SUMSUB_BASE_URL: z.string().url().default('https://api.sumsub.com'),
    SUMSUB_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1200),

    // Sartblock (AML)
    SARTBLOCK_BASE_URL: z.string().url().optional(),
    SARTBLOCK_API_KEY: z.string().optional(),

    // Liquidez BRL (socio por definir). Por defecto sigue PROVIDERS_MODE.
    BRL_PROVIDER_MODE: z.enum(['mock', 'live']).optional(),

    // OTP WhatsApp/SMS ('mock' para código fijo 123456, 'twilio' para WhatsApp/SMS real con Twilio)
    OTP_PROVIDER_MODE: z.enum(['mock', 'twilio', 'live']).default('mock'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
    TWILIO_WHATSAPP_FROM: z.string().default('+14155238886'),
    TWILIO_WHATSAPP_CONTENT_SID: z.string().optional(),
    TWILIO_SMS_FROM: z.string().optional(),

    // OTP Correo electrónico (Resend — dominio cuypay.com)
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().default('CuyPay <no-reply@cuypay.com>'),

    // APNs Push Notifications (iOS)
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_PRIVATE_KEY: z.string().optional(),
    APNS_BUNDLE_ID: z.string().default('com.cuypay.app'),

    // FX / tarifas
    FX_SPREAD_BPS: z.coerce.number().int().min(0).max(5000).default(150),
    CONVERSION_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(100),
    CONVERSION_FEE_MIN_MINOR: z.coerce.number().int().min(0).default(0),
    QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
    TRANSFER_FEE_MINOR: z.coerce.number().int().min(0).default(0),

    LIMITS_CONFIG_JSON: z.string().optional(),
    SEED_DEMO: bool.optional(),
    ENABLE_DEV_ROUTES: bool.optional(),

    // Portal admin (docs/ADMIN_API.md)
    ADMIN_JWT_SECRET: z.string().min(32).optional(), // por defecto se deriva de JWT_SECRET (HMAC), nunca es la misma clave
    ADMIN_JWT_AUDIENCE: z.string().default('cuypay-admin'),
    ADMIN_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(1800),
    ADMIN_ORIGINS: z.string().optional(), // p. ej. https://www.cuypay.com (coma-separado)
    ADMIN_TOTP_ISSUER: z.string().default('CuyPay Admin'),
    ADMIN_SEED_EMAIL: z.string().email().optional(),
    ADMIN_SEED_PASSWORD: z.string().min(12).optional(),
    ADMIN_SEED_TOTP_SECRET: z.string().regex(/^[A-Z2-7]{16,64}$/, 'base32 (A-Z, 2-7), 16-64 caracteres').optional(),
    ADMIN_SEED_NAME: z.string().default('CuyPay Owner'),
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(), // p. ej. cuypay.cloudflareaccess.com
    CF_ACCESS_AUD: z.string().optional(),
    ALERT_LARGE_TX_MINOR: z.coerce.number().int().positive().default(1_000_000_000), // COP 10.000.000,00
    PROVIDER_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET es obligatorio en producción' });
    }
    if (Boolean(env.CF_ACCESS_TEAM_DOMAIN) !== Boolean(env.CF_ACCESS_AUD)) {
      ctx.addIssue({ code: 'custom', path: ['CF_ACCESS_AUD'], message: 'CF_ACCESS_TEAM_DOMAIN y CF_ACCESS_AUD van juntos' });
    }
    if (env.PROVIDERS_MODE === 'live') {
      const required = [
        'COINSENDA_EMAIL',
        'COINSENDA_PRIVATE_KEY_PEM',
        'COINSENDA_BREB_DEPOSIT_ACCOUNT_ID',
        'COINSENDA_COP_ACCOUNT_ID',
      ] as const;
      for (const key of required) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} es obligatorio con PROVIDERS_MODE=live` });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<Env, 'JWT_SECRET' | 'LIMITS_CONFIG_JSON' | 'SEED_DEMO' | 'ENABLE_DEV_ROUTES' | 'ADMIN_JWT_SECRET'> {
  JWT_SECRET: string;
  /** Clave HS256 de los tokens admin (distinta de la de clientes). */
  ADMIN_JWT_SECRET: string;
  limits: LimitsConfig;
  seedDemo: boolean;
  devRoutes: boolean;
  corsOrigins: string[];
  adminOrigins: string[];
}

const splitList = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val !== '') out[key] = val;
    }
  } catch {
    // Ignorar si no es legible.
  }
  return out;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const effectiveSource =
    source === process.env
      ? { ...source, ...parseDotEnvFile(process.env.RUNTIME_ENV_FILE || '/app/.env.runtime') }
      : source;
  // Las cadenas vacías se tratan como "no definida".
  const cleaned = Object.fromEntries(Object.entries(effectiveSource).filter(([, v]) => v !== undefined && v !== ''));
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
  const { LIMITS_CONFIG_JSON: _l, SEED_DEMO, ENABLE_DEV_ROUTES, JWT_SECRET, ADMIN_JWT_SECRET, ...rest } = env;
  const jwtSecret = JWT_SECRET ?? DEV_JWT_SECRET;
  return {
    ...rest,
    JWT_SECRET: jwtSecret,
    ADMIN_JWT_SECRET: ADMIN_JWT_SECRET ?? createHmac('sha256', jwtSecret).update('cuypay-admin-jwt-v1').digest('base64url'),
    limits,
    seedDemo: SEED_DEMO ?? (env.NODE_ENV === 'development' && env.PROVIDERS_MODE === 'mock'),
    // Las rutas /v1/dev/* nunca se habilitan en producción ni en modo live.
    devRoutes: !isProd && env.PROVIDERS_MODE === 'mock' && (ENABLE_DEV_ROUTES ?? true),
    corsOrigins: splitList(env.CORS_ORIGINS),
    adminOrigins: splitList(env.ADMIN_ORIGINS),
  };
}
