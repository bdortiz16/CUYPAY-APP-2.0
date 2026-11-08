import type { Container } from '../container.js';
import { otpauthUrl } from '../lib/totp.js';

/** Credenciales del owner de desarrollo (solo NODE_ENV≠production; sobrescribibles por env). */
export const DEV_ADMIN = {
  email: 'admin@cuypay.com',
  password: 'CuyPay-Admin-Dev-2026!',
  totpSecret: 'CUYPAYDEVADMINTOTPSECRET234567AB',
} as const;

/**
 * Crea el primer usuario admin (owner) si no existe ninguno.
 * - Desarrollo/test: ADMIN_SEED_* o los valores de DEV_ADMIN, y se loguean las credenciales.
 * - Producción: solo si ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD y ADMIN_SEED_TOTP_SECRET están definidos;
 *   nunca se loguean credenciales.
 */
export async function seedAdmin(container: Container) {
  const { config, deps, services } = container;
  const existing = await deps.repos.adminUsers.list();
  if (existing.length) return null;
  const isProd = config.NODE_ENV === 'production';
  if (isProd && !(config.ADMIN_SEED_EMAIL && config.ADMIN_SEED_PASSWORD && config.ADMIN_SEED_TOTP_SECRET)) {
    deps.logger.warn('No hay usuarios admin: define ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD y ADMIN_SEED_TOTP_SECRET para crear el owner inicial');
    return null;
  }
  const email = config.ADMIN_SEED_EMAIL ?? DEV_ADMIN.email;
  const password = config.ADMIN_SEED_PASSWORD ?? DEV_ADMIN.password;
  const totpSecret = config.ADMIN_SEED_TOTP_SECRET ?? DEV_ADMIN.totpSecret;
  const admin = await services.admin.auth.createRaw({ email, name: config.ADMIN_SEED_NAME, role: 'owner', password, totpSecret });
  const url = otpauthUrl(config.ADMIN_TOTP_ISSUER, admin.email, totpSecret);
  if (isProd) {
    deps.logger.info({ adminId: admin.id }, 'owner admin inicial creado desde ADMIN_SEED_*');
  } else {
    // Solo fuera de producción: credenciales de desarrollo para entrar al portal.
    deps.logger.warn(
      { adminEmail: admin.email, adminPassword: password, adminTotpSecret: totpSecret, otpauthUrl: url },
      'DEV admin owner creado (credenciales de desarrollo; NO usar en producción)',
    );
  }
  return { admin, otpauthUrl: url };
}
