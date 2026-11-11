import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import type { CardHolderDocumentType, KycProvider, KycVerifiedAddress, KycVerifiedProfile } from '../../ports/index.js';

/** Firma de peticiones Sumsub: HMAC-SHA256(secret, ts + METHOD + pathWithQuery + body) en hex. */
export function signSumsubRequest(secret: string, ts: number, method: string, pathWithQuery: string, body = ''): string {
  return createHmac('sha256', secret).update(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`).digest('hex');
}

interface SumsubIdDocPayload {
  idDocType?: string;
  idDocSubType?: string;
  country?: string;
  firstName?: string;
  firstNameEn?: string;
  lastName?: string;
  lastNameEn?: string;
  number?: string;
  dob?: string;
}

interface SumsubAddressPayload {
  country?: string;
  state?: string;
  stateEn?: string;
  town?: string;
  townEn?: string;
  postCode?: string;
  street?: string;
  streetEn?: string;
  subStreet?: string;
  subStreetEn?: string;
  buildingNumber?: string;
  buildingName?: string;
  flatNumber?: string;
  formattedAddress?: string;
}

interface SumsubApplicantInfoPayload {
  firstName?: string;
  firstNameEn?: string;
  lastName?: string;
  lastNameEn?: string;
  dob?: string;
  country?: string;
  nationality?: string;
  idDocs?: SumsubIdDocPayload[];
  addresses?: SumsubAddressPayload[];
}

interface SumsubApplicantResponse {
  id?: string;
  externalUserId?: string;
  email?: string;
  phone?: string;
  info?: SumsubApplicantInfoPayload;
  fixedInfo?: SumsubApplicantInfoPayload;
}

function mapSumsubDocumentType(doc?: SumsubIdDocPayload, isSandboxMock = false): CardHolderDocumentType {
  const rawType = String(doc?.idDocType ?? '').toUpperCase();
  const subType = String(doc?.idDocSubType ?? '').toUpperCase();
  const docCountry = String(doc?.country ?? '').toUpperCase();

  if (rawType === 'PASSPORT') return 'pasaporte';
  if (rawType === 'RESIDENCE_PERMIT') {
    if (subType.includes('PPT') || subType.includes('PROT') || subType.includes('TEMP')) return 'ppt';
    if (subType.includes('PEP') || subType.includes('ESP')) return 'pep';
    return 'cedula_extranjeria';
  }
  if (rawType === 'ID_CARD' && !isSandboxMock && docCountry && !['COL', 'CO', 'COLOMBIA'].includes(docCountry)) {
    return 'cedula_extranjeria';
  }
  return 'cedula_ciudadania';
}

function extractSumsubAddress(info?: SumsubApplicantInfoPayload, fixed?: SumsubApplicantInfoPayload): KycVerifiedAddress | null {
  const addr = info?.addresses?.[0] ?? fixed?.addresses?.[0];
  if (!addr) return null;

  const country = addr.country?.trim();
  const province = (addr.state || addr.stateEn)?.trim();
  const city = (addr.town || addr.townEn)?.trim();
  const zipCode = addr.postCode?.trim();
  const streetName = (addr.street || addr.streetEn || addr.formattedAddress)?.trim();
  const streetNumber = addr.buildingNumber?.trim();
  const district = (addr.subStreet || addr.subStreetEn)?.trim();
  const extraParts = [
    addr.buildingName?.trim(),
    addr.flatNumber?.trim() ? `Apto ${addr.flatNumber.trim()}` : undefined,
  ].filter(Boolean);
  const additionalInfo = extraParts.length > 0 ? extraParts.join(' ') : undefined;

  if (!country && !province && !city && !streetName) return null;
  return { country, province, city, zipCode, streetName, streetNumber, district, additionalInfo };
}

export interface LiveSumsubOptions {
  baseUrl: string;
  appToken: string;
  secretKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class LiveSumsubProvider implements KycProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: LiveSumsubOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: 'GET' | 'POST', pathWithQuery: string, body?: unknown): Promise<{ status: number; json: T }> {
    const ts = Math.floor(Date.now() / 1000);
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Token': this.opts.appToken,
      'X-App-Access-Ts': String(ts),
      'X-App-Access-Sig': signSumsubRequest(this.opts.secretKey, ts, method, pathWithQuery, bodyStr),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl.replace(/\/$/, '') + pathWithQuery, {
        method,
        headers,
        body: body === undefined ? undefined : bodyStr,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.opts.logger.error({ err: (err as Error).message, path: pathWithQuery.split('?')[0] }, 'sumsub network error');
      throw new AppError('PROVIDER_ERROR', 'Sumsub no respondió', { provider: 'sumsub' });
    }
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, json };
  }

  /**
   * Health check: consulta firmada de un applicant inexistente. 404 = Sumsub responde y la firma es válida;
   * 401/403 = credenciales inválidas; 5xx / red = caído.
   */
  async healthCheck(): Promise<void> {
    const { status } = await this.request('GET', '/resources/applicants/-;externalUserId=cuypay-healthcheck/one');
    if (status === 401 || status === 403) throw new AppError('PROVIDER_ERROR', 'Sumsub rechazó las credenciales', { provider: 'sumsub', status });
    if (status >= 500) throw new AppError('PROVIDER_ERROR', `Sumsub respondió ${status}`, { provider: 'sumsub', status });
  }

  async createApplicant(input: {
    externalUserId: string;
    levelName: string;
    email: string;
    phone: string;
    firstName: string;
    lastName: string;
    country: string;
  }) {
    const path = `/resources/applicants?levelName=${encodeURIComponent(input.levelName)}`;
    const { status, json } = await this.request<{ id?: string; description?: string; code?: number }>('POST', path, {
      externalUserId: input.externalUserId,
      email: input.email,
      phone: input.phone,
      fixedInfo: { firstName: input.firstName, lastName: input.lastName, country: input.country === 'CO' ? 'COL' : input.country },
    });
    if (status === 409) {
      // Ya existe un applicant con ese externalUserId: lo leemos.
      const existing = await this.request<{ id?: string }>(
        'GET',
        `/resources/applicants/-;externalUserId=${encodeURIComponent(input.externalUserId)}/one`,
      );
      if (existing.status < 300 && existing.json.id) return { applicantId: existing.json.id };
    }
    if (status >= 300 || !json.id) {
      this.opts.logger.warn({ status, code: json.code }, 'sumsub createApplicant failed');
      throw new AppError('PROVIDER_ERROR', 'No se pudo crear el applicant en Sumsub', { provider: 'sumsub', status });
    }
    return { applicantId: json.id };
  }

  async createSdkAccessToken(input: { externalUserId: string; levelName: string; ttlInSecs: number }) {
    const { status, json } = await this.request<{ token?: string }>('POST', '/resources/accessTokens/sdk', {
      userId: input.externalUserId,
      levelName: input.levelName,
      ttlInSecs: input.ttlInSecs,
    });
    if (status >= 300 || !json.token) {
      this.opts.logger.warn({ status }, 'sumsub access token failed');
      throw new AppError('PROVIDER_ERROR', 'No se pudo obtener el token de Sumsub', { provider: 'sumsub', status });
    }
    return { token: json.token };
  }

  async getApplicantProfile(input: { applicantId?: string | null; externalUserId: string }): Promise<KycVerifiedProfile | null> {
    let applicant: SumsubApplicantResponse | null = null;

    if (input.applicantId && !input.applicantId.startsWith('mock_applicant_')) {
      const byId = await this.request<SumsubApplicantResponse>(
        'GET',
        `/resources/applicants/${encodeURIComponent(input.applicantId)}/one`,
      );
      if (byId.status < 300 && byId.json?.id) {
        applicant = byId.json;
      } else if (byId.status >= 500 || byId.status === 401 || byId.status === 403) {
        throw new AppError('PROVIDER_ERROR', 'No se pudo consultar el perfil verificado en Sumsub', {
          provider: 'sumsub',
          status: byId.status,
        });
      }
    }

    if (!applicant) {
      const byExt = await this.request<SumsubApplicantResponse>(
        'GET',
        `/resources/applicants/-;externalUserId=${encodeURIComponent(input.externalUserId)}/one`,
      );
      if (byExt.status === 404) return null;
      if (byExt.status >= 300 || !byExt.json?.id) {
        throw new AppError('PROVIDER_ERROR', 'No se pudo consultar el perfil verificado en Sumsub', {
          provider: 'sumsub',
          status: byExt.status,
        });
      }
      applicant = byExt.json;
    }

    const info = applicant.info;
    const fixed = applicant.fixedInfo;
    const docs = [...(info?.idDocs ?? []), ...(fixed?.idDocs ?? [])];
    const primaryDoc =
      docs.find((d) => ['ID_CARD', 'RESIDENCE_PERMIT', 'PASSPORT'].includes(String(d.idDocType ?? '').toUpperCase())) ??
      docs[0];

    const rawDocNumber = String(primaryDoc?.number ?? '').trim();
    const isSandboxMockDocument =
      /^mock-/i.test(rawDocNumber) ||
      /mock-doe/i.test(String(info?.lastName ?? '')) ||
      /mock-doe/i.test(String(primaryDoc?.lastName ?? ''));

    const firstName = (
      isSandboxMockDocument
        ? fixed?.firstName || fixed?.firstNameEn || ''
        : info?.firstName || info?.firstNameEn || primaryDoc?.firstName || fixed?.firstName || ''
    ).trim();

    const lastName = (
      isSandboxMockDocument
        ? fixed?.lastName || fixed?.lastNameEn || ''
        : info?.lastName || info?.lastNameEn || primaryDoc?.lastName || fixed?.lastName || ''
    ).trim();

    const documentType = mapSumsubDocumentType(primaryDoc, isSandboxMockDocument);
    let documentNumber: string | null = null;
    if (!isSandboxMockDocument && rawDocNumber) {
      documentNumber =
        documentType === 'pasaporte'
          ? rawDocNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
          : rawDocNumber.replace(/\D/g, '') || rawDocNumber.replace(/[^0-9A-Za-z]/g, '');
    } else if (isSandboxMockDocument) {
      const fixedRealDoc = (fixed?.idDocs ?? []).find((d) => d.number && !/^mock-/i.test(d.number));
      if (fixedRealDoc?.number) {
        documentNumber = fixedRealDoc.number.replace(/[^0-9A-Za-z]/g, '');
      }
    }

    const birthdate = (
      isSandboxMockDocument
        ? fixed?.dob || info?.dob || primaryDoc?.dob || null
        : info?.dob || primaryDoc?.dob || fixed?.dob || null
    );

    const nationality = (
      isSandboxMockDocument
        ? fixed?.nationality || fixed?.country || info?.nationality || info?.country || null
        : info?.nationality || info?.country || fixed?.nationality || fixed?.country || null
    );

    const documentCountry = (
      isSandboxMockDocument
        ? fixed?.country || 'COL'
        : primaryDoc?.country || info?.country || fixed?.country || 'COL'
    );

    return {
      applicantId: applicant.id!,
      firstName,
      lastName,
      birthdate: birthdate ? String(birthdate).slice(0, 10) : null,
      nationality,
      documentCountry,
      documentType,
      documentNumber: documentNumber || null,
      isSandboxMockDocument,
      email: applicant.email?.trim() || null,
      phone: applicant.phone?.trim() || null,
      address: extractSumsubAddress(info, fixed),
    };
  }
}

/** Sumsub simulado: tokens opacos; la aprobación llega por webhook firmado (o /v1/dev/kyc/approve). */
export class MockSumsubProvider implements KycProvider {
  async createApplicant() {
    return { applicantId: `mock_applicant_${randomUUID()}` };
  }
  async createSdkAccessToken(input: { externalUserId: string }) {
    return { token: `_act-sbx-mock-${input.externalUserId}-${randomUUID()}` };
  }
  async getApplicantProfile(): Promise<KycVerifiedProfile | null> {
    return null;
  }
}
