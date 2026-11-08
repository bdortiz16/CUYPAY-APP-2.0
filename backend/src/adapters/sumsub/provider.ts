import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import type { KycProvider } from '../../ports/index.js';

/** Firma de peticiones Sumsub: HMAC-SHA256(secret, ts + METHOD + pathWithQuery + body) en hex. */
export function signSumsubRequest(secret: string, ts: number, method: string, pathWithQuery: string, body = ''): string {
  return createHmac('sha256', secret).update(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`).digest('hex');
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
}

/** Sumsub simulado: tokens opacos; la aprobación llega por webhook firmado (o /v1/dev/kyc/approve). */
export class MockSumsubProvider implements KycProvider {
  async createApplicant() {
    return { applicantId: `mock_applicant_${randomUUID()}` };
  }
  async createSdkAccessToken(input: { externalUserId: string }) {
    return { token: `_act-sbx-mock-${input.externalUserId}-${randomUUID()}` };
  }
}
