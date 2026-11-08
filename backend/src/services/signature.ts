import { canonicalRequestString, verifyP256Der } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { AccessClaims } from './auth.js';
import type { ServiceDeps } from './deps.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignedRequestInput {
  deviceId: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  method: string;
  path: string; // con /v1, sin query
  rawBody: Buffer | undefined;
}

/**
 * Verificación de peticiones firmadas (🔐), contrato §1:
 *  1. Headers presentes → si no, SIGNATURE_REQUIRED.
 *  2. El dispositivo del header es el de la sesión y está activo.
 *  3. |ahora - timestamp| ≤ 120 s → si no, INVALID_SIGNATURE (reason: clock_skew).
 *  4. Firma ECDSA-SHA256 DER sobre la cadena canónica → INVALID_SIGNATURE.
 *  5. Nonce no visto antes para ese dispositivo → REPLAYED_NONCE.
 *     (Se registra DESPUÉS de verificar la firma para que un tercero no pueda "quemar" nonces.)
 */
export class SignatureService {
  constructor(private readonly d: ServiceDeps) {}

  async verify(input: SignedRequestInput, claims: AccessClaims): Promise<void> {
    const { deviceId, timestamp, nonce, signature } = input;
    if (!deviceId || !timestamp || !nonce || !signature) {
      throw new AppError('SIGNATURE_REQUIRED', 'Esta operación requiere firma del dispositivo', {
        requiredHeaders: ['X-CuyPay-Device', 'X-CuyPay-Timestamp', 'X-CuyPay-Nonce', 'X-CuyPay-Signature'],
      });
    }
    if (deviceId !== claims.deviceId) {
      throw new AppError('INVALID_SIGNATURE', 'El dispositivo firmante no corresponde a la sesión', { reason: 'device_mismatch' });
    }
    const device = await this.d.repos.devices.byId(deviceId);
    if (!device || device.revokedAt || device.userId !== claims.userId) {
      throw new AppError('INVALID_SIGNATURE', 'Dispositivo no válido', { reason: 'device_invalid' });
    }
    if (!/^\d{1,12}$/.test(timestamp)) {
      throw new AppError('INVALID_SIGNATURE', 'Timestamp inválido', { reason: 'bad_timestamp' });
    }
    if (!UUID_V4.test(nonce)) {
      throw new AppError('INVALID_SIGNATURE', 'Nonce inválido (se espera UUID v4)', { reason: 'bad_nonce' });
    }
    const now = this.d.clock.now();
    const nowSec = Math.floor(now.getTime() / 1000);
    const skew = Math.abs(nowSec - Number(timestamp));
    const maxSkew = this.d.config.SIGNATURE_MAX_SKEW_SECONDS;
    if (skew > maxSkew) {
      throw new AppError('INVALID_SIGNATURE', 'Timestamp fuera de la ventana permitida', { reason: 'clock_skew', maxSkewSeconds: maxSkew });
    }
    const canonical = canonicalRequestString({ method: input.method, path: input.path, rawBody: input.rawBody, timestamp, nonce });
    if (!verifyP256Der(device.publicKey, canonical, signature)) {
      throw new AppError('INVALID_SIGNATURE', 'Firma inválida', { reason: 'bad_signature' });
    }
    // El nonce se guarda hasta que el timestamp ya no pueda ser aceptado.
    const expiresAt = new Date((Number(timestamp) + maxSkew + 1) * 1000);
    const fresh = await this.d.repos.nonces.register(deviceId, nonce.toLowerCase(), expiresAt, now);
    if (!fresh) throw new AppError('REPLAYED_NONCE', 'Nonce ya utilizado');
    device.lastUsedAt = now;
    await this.d.repos.devices.update(device);
  }
}
