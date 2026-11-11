import type { KycApplicant, User } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import { assertDeliverableEmail, isPlaceholderEmail } from '../lib/email-validator.js';
import { mapSumsubEvent, verifySumsubWebhook, type SumsubWebhookPayload } from '../adapters/sumsub/webhook.js';
import type { ServiceDeps } from './deps.js';

export const DEV_SUMSUB_WEBHOOK_SECRET = 'dev-sumsub-webhook-secret';

/** Exige KYC aprobado: KYC_PENDING si está en revisión, KYC_REQUIRED en otro caso. */
export function requireKycApproved(user: User): void {
  if (user.kycStatus === 'approved') return;
  if (user.kycStatus === 'pending') throw new AppError('KYC_PENDING', 'Tu verificación de identidad está en revisión');
  throw new AppError('KYC_REQUIRED', 'Debes completar la verificación de identidad', { kycStatus: user.kycStatus });
}

export class KycService {
  constructor(private readonly d: ServiceDeps) {}

  get webhookSecret(): string {
    return this.d.config.SUMSUB_WEBHOOK_SECRET ?? DEV_SUMSUB_WEBHOOK_SECRET;
  }

  private async getOrCreateApplicant(user: User): Promise<KycApplicant> {
    const existing = await this.d.repos.kyc.byUser(user.id);
    if (existing?.applicantId) return existing;
    const levelName = this.d.config.SUMSUB_LEVEL_NAME;
    const { applicantId } = await this.d.kyc.createApplicant({
      externalUserId: user.id,
      levelName,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      country: user.country,
    });
    const rec: KycApplicant = {
      userId: user.id,
      provider: 'sumsub',
      applicantId,
      levelName,
      status: user.kycStatus,
      reviewAnswer: null,
      rejectLabels: [],
      rejectType: null,
      updatedAt: this.d.clock.now(),
    };
    await this.d.repos.kyc.upsert(rec);
    return rec;
  }

  async sdkToken(user: User) {
    const applicant = await this.getOrCreateApplicant(user);
    const levelName = this.d.config.SUMSUB_LEVEL_NAME;
    if (applicant.levelName !== levelName && user.kycStatus !== 'approved') {
      applicant.levelName = levelName;
      applicant.updatedAt = this.d.clock.now();
      await this.d.repos.kyc.upsert(applicant);
    }
    const ttl = this.d.config.SUMSUB_TOKEN_TTL_SECONDS;
    const { token } = await this.d.kyc.createSdkAccessToken({ externalUserId: user.id, levelName, ttlInSecs: ttl });
    return { token, levelName, expiresAt: new Date(this.d.clock.now().getTime() + ttl * 1000) };
  }

  async status(user: User) {
    const rec = await this.d.repos.kyc.byUser(user.id);
    return {
      status: user.kycStatus,
      tier: user.tier,
      ...(rec?.reviewAnswer ? { reviewAnswer: rec.reviewAnswer } : {}),
      ...(rec?.rejectLabels.length ? { rejectLabels: rec.rejectLabels } : {}),
    };
  }

  /** Procesa un webhook de Sumsub ya autenticado por firma. Idempotente. */
  async handleWebhook(rawBody: Buffer | undefined, digest: string | undefined, alg: string | undefined) {
    if (!verifySumsubWebhook(this.webhookSecret, rawBody, digest, alg)) {
      throw new AppError('INVALID_SIGNATURE', 'Firma del webhook inválida');
    }
    let payload: SumsubWebhookPayload;
    try {
      payload = JSON.parse(rawBody!.toString('utf8')) as SumsubWebhookPayload;
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Cuerpo del webhook inválido');
    }
    const status = mapSumsubEvent(payload);
    const user = payload.externalUserId ? await this.d.repos.users.byId(payload.externalUserId) : null;
    if (!user) {
      this.d.logger.warn({ type: payload.type }, 'sumsub webhook for unknown user');
      return { processed: false };
    }
    if (!status) return { processed: false };
    await this.applyStatus(user, status, {
      applicantId: payload.applicantId ?? null,
      reviewAnswer: payload.reviewResult?.reviewAnswer ?? null,
      rejectLabels: payload.reviewResult?.rejectLabels ?? [],
      rejectType: payload.reviewResult?.reviewRejectType ?? null,
    });
    return { processed: true };
  }

  async applyStatus(
    user: User,
    status: User['kycStatus'],
    info: { applicantId: string | null; reviewAnswer: string | null; rejectLabels: string[]; rejectType: string | null },
  ) {
    const now = this.d.clock.now();
    // Un aprobado final no se degrada por eventos tardíos de "pending".
    if (user.kycStatus === 'approved' && status === 'pending') return;
    const existing = await this.d.repos.kyc.byUser(user.id);
    const resolvedApplicantId = info.applicantId ?? existing?.applicantId ?? null;
    let preservedCardHolderId = existing?.providerCardHolderId;

    if (status === 'approved' && this.d.kyc.getApplicantProfile) {
      try {
        const profile = await this.d.kyc.getApplicantProfile({
          applicantId: resolvedApplicantId,
          externalUserId: user.id,
        });
        if (profile) {
          if (!profile.isSandboxMockDocument) {
            if (profile.firstName && user.firstName.trim().toLowerCase() === 'usuario') {
              user.firstName = profile.firstName;
            }
            if (profile.lastName && user.lastName.trim().toLowerCase() === 'cuypay') {
              user.lastName = profile.lastName;
            }
          }

          const isLive = this.d.config.PROVIDERS_MODE === 'live';
          const isSumsubSandbox = Boolean(this.d.config.SUMSUB_APP_TOKEN?.startsWith('sbx:'));
          const candidateKycEmail =
            profile.verifiedEmailFromKyc ?? (isPlaceholderEmail(user.email) ? profile.email : null);

          if (candidateKycEmail) {
            try {
              const validKycEmail = await assertDeliverableEmail(candidateKycEmail, { isLive });
              const shouldReplaceEmail =
                isPlaceholderEmail(user.email) ||
                (Boolean(profile.verifiedEmailFromKyc) && !isSumsubSandbox && validKycEmail !== user.email.trim().toLowerCase());
              if (shouldReplaceEmail) {
                const owner = await this.d.repos.users.byEmail(validKycEmail);
                if (!owner || owner.id === user.id) {
                  user.email = validKycEmail;
                  preservedCardHolderId = null;
                }
              }
            } catch {
              this.d.logger.warn(
                { userId: user.id, candidateKycEmail },
                'ignoring undeliverable or generic email from sumsub profile',
              );
            }
          }

          if (profile.verifiedPhoneFromKyc && profile.verifiedPhoneFromKyc !== user.phone && !isSumsubSandbox) {
            const owner = await this.d.repos.users.byPhone(profile.verifiedPhoneFromKyc);
            if (!owner || owner.id === user.id) {
              user.phone = profile.verifiedPhoneFromKyc;
              preservedCardHolderId = null;
            }
          }
        }
      } catch (err) {
        this.d.logger.warn({ userId: user.id, err: (err as Error).message }, 'sumsub profile sync skipped on approval');
      }
    }

    await this.d.repos.kyc.upsert({
      userId: user.id,
      provider: 'sumsub',
      applicantId: resolvedApplicantId,
      ...(preservedCardHolderId ? { providerCardHolderId: preservedCardHolderId } : {}),
      levelName: this.d.config.SUMSUB_LEVEL_NAME,
      status,
      reviewAnswer: info.reviewAnswer ?? existing?.reviewAnswer ?? null,
      rejectLabels: info.rejectLabels,
      rejectType: info.rejectType,
      updatedAt: now,
    });

    user.kycStatus = status;
    user.tier = status === 'approved' ? 'full' : 'basic';
    user.updatedAt = now;
    await this.d.repos.users.update(user);
    this.d.logger.info({ userId: user.id, kycStatus: status }, 'kyc status updated');
    await this.d.events.publish({ type: 'kyc.updated', userId: user.id, status: user.kycStatus, tier: user.tier });
  }
}
