import { presentDevice, presentTransaction } from '../domain/presenters.js';
import type { Currency } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [ts, id] = raw.split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new AppError('VALIDATION_ERROR', 'Cursor inválido', { field: 'cursor' });
  return { createdAt, id };
}

/** Feed de transacciones con paginación por cursor (createdAt DESC, id DESC). */
export class TransactionService {
  constructor(private readonly d: ServiceDeps) {}

  async list(userId: string, opts: { currency?: Currency; limit: number; cursor?: string }) {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const rows = await this.d.repos.transactions.listByUser(userId, { currency: opts.currency, limit: opts.limit + 1, after });
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(presentTransaction),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

/** Dispositivos vinculados. */
export class DeviceService {
  constructor(private readonly d: ServiceDeps) {}

  async list(userId: string, currentDeviceId: string) {
    const devices = (await this.d.repos.devices.listByUser(userId))
      .filter((x) => !x.revokedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: devices.map((x) => presentDevice(x, currentDeviceId)) };
  }

  async revoke(userId: string, deviceId: string) {
    const dev = await this.d.repos.devices.byId(deviceId);
    if (!dev || dev.userId !== userId || dev.revokedAt) throw new AppError('NOT_FOUND', 'Dispositivo no encontrado');
    const now = this.d.clock.now();
    dev.revokedAt = now;
    await this.d.repos.devices.update(dev);
    await this.d.repos.refreshTokens.revokeByDevice(deviceId, now);
  }

  async registerPushToken(
    userId: string,
    deviceId: string,
    token: string,
    environment: 'sandbox' | 'production' = 'production',
  ) {
    const dev = await this.d.repos.devices.byId(deviceId);
    if (!dev || dev.userId !== userId || dev.revokedAt) {
      throw new AppError('NOT_FOUND', 'Dispositivo no encontrado');
    }
    dev.pushToken = token.trim();
    dev.pushEnvironment = environment;
    dev.lastUsedAt = this.d.clock.now();
    await this.d.repos.devices.update(dev);
    return { registered: true as const };
  }
}
