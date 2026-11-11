import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError, type ZodType } from 'zod';
import type { Container } from '../container.js';
import type { User } from '../domain/types.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { AccessClaims } from '../services/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerKycRoutes } from './routes/kyc.js';
import { registerMoneyRoutes } from './routes/money.js';
import { registerSavingsRoutes } from './routes/savings.js';
import { registerLoanRoutes } from './routes/loans.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerAdminRoutes } from './routes/admin.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    auth?: AccessClaims;
  }
}

/** Valida con zod y lanza VALIDATION_ERROR con los issues en details. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw zodToAppError(r.error);
  return r.data;
}

function zodToAppError(e: ZodError): AppError {
  return new AppError('VALIDATION_ERROR', 'Datos inválidos', {
    issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export interface RouteHelpers {
  /** preHandler: exige Bearer válido. */
  authenticate: (req: FastifyRequest) => Promise<void>;
  /** preHandler: exige firma de dispositivo (🔐). Debe ir después de `authenticate`. */
  requireSignature: (req: FastifyRequest) => Promise<void>;
  /** Usuario de la sesión. */
  currentUser: (req: FastifyRequest) => Promise<User>;
  /** Config de rate limit para rutas de auth. */
  authRateLimit: { rateLimit: { max: number; timeWindow: number } };
}

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { config, deps, services } = container;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: 64 * 1024,
    trustProxy: config.NODE_ENV === 'production',
    genReqId: () => crypto.randomUUID(),
  });

  // Cuerpo crudo: necesario para la firma de dispositivo (sha256 del body) y el webhook de Sumsub.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new AppError('VALIDATION_ERROR', 'JSON inválido'), undefined);
    }
  });

  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  // CORS desactivado por defecto (la app iOS no lo necesita). Solo si CORS_ORIGINS o ADMIN_ORIGINS están definidos.
  // Los orígenes de ADMIN_ORIGINS solo se aceptan para /v1/admin/*.
  if (config.corsOrigins.length || config.adminOrigins.length) {
    await app.register(cors, {
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      delegator: (req, cb) => {
        const origin = req.headers.origin;
        const path = req.url ?? '';
        const isWildcard = config.corsOrigins.includes('*') || config.adminOrigins.includes('*');
        const isCuypayOrigin = !!origin && (origin.endsWith('cuypay.com') || origin.includes('localhost') || origin.includes('127.0.0.1'));
        const allowed =
          isWildcard ||
          isCuypayOrigin ||
          (!!origin && (config.corsOrigins.includes(origin) || (config.adminOrigins.includes(origin) && path.startsWith('/v1/admin'))));
        cb(null, { origin: allowed ? (origin ?? true) : false, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], credentials: true });
      },
    });
  }
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', 'Demasiadas solicitudes, intenta más tarde', { retryAfterMs: ctx.ttl }),
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    let appErr: AppError;
    if (isAppError(err)) appErr = err;
    else if (err instanceof ZodError) appErr = zodToAppError(err);
    else {
      const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
      if (e.validation || e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 400 || e.statusCode === 415 || e.statusCode === 413) {
        appErr = new AppError('VALIDATION_ERROR', e.message ?? 'Solicitud inválida', {}, e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 400);
      } else if (e.statusCode === 429) {
        appErr = new AppError('RATE_LIMITED', 'Demasiadas solicitudes');
      } else {
        req.log.error({ err }, 'unhandled error');
        appErr = new AppError('INTERNAL_ERROR', 'Error inesperado');
      }
    }
    if (appErr.status >= 500 && appErr.code !== 'INTERNAL_ERROR') req.log.warn({ code: appErr.code, details: appErr.details }, appErr.message);
    void reply.status(appErr.status).send(appErr.toBody());
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send(new AppError('NOT_FOUND', 'Ruta no encontrada').toBody());
  });

  const helpers: RouteHelpers = {
    authenticate: async (req) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) throw new AppError('UNAUTHORIZED', 'Falta el token de acceso');
      req.auth = await services.auth.authenticate(h.slice(7).trim());
    },
    requireSignature: async (req) => {
      if (!req.auth) throw new AppError('UNAUTHORIZED', 'Falta el token de acceso');
      const header = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? undefined : v;
      };
      await services.signature.verify(
        {
          deviceId: header('x-cuypay-device'),
          timestamp: header('x-cuypay-timestamp'),
          nonce: header('x-cuypay-nonce'),
          signature: header('x-cuypay-signature'),
          method: req.method,
          path: req.url.split('?')[0] ?? req.url,
          rawBody: req.rawBody,
        },
        req.auth,
      );
    },
    currentUser: async (req) => {
      if (!req.auth) throw new AppError('UNAUTHORIZED', 'Falta el token de acceso');
      const u = await deps.repos.users.byId(req.auth.userId);
      if (!u) throw new AppError('UNAUTHORIZED', 'Usuario inexistente');
      return u;
    },
    authRateLimit: { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: config.AUTH_RATE_LIMIT_WINDOW_MS } },
  };

  const health = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.send({ ok: true, service: 'cuypay-backend', mode: config.PROVIDERS_MODE, time: deps.clock.now().toISOString() });
  app.get('/health', health);

  await app.register(
    async (v1) => {
      v1.get('/health', health);
      registerAuthRoutes(v1, container, helpers);
      registerAccountRoutes(v1, container, helpers);
      registerKycRoutes(v1, container, helpers);
      registerMoneyRoutes(v1, container, helpers);
      registerSavingsRoutes(v1, container, helpers);
      registerLoanRoutes(v1, container, helpers);
      registerAdminRoutes(v1, container, helpers);
      if (config.devRoutes || config.ADMIN_API_KEY) registerDevRoutes(v1, container, helpers);
    },
    { prefix: '/v1' },
  );

  return app;
}
