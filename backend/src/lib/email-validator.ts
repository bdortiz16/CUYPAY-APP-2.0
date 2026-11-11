import { promises as dns, type MxRecord } from 'node:dns';
import { AppError } from './errors.js';

const EMAIL_FORMAT_RE = /^[^\s@]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

const BLOCKED_GENERIC_OR_DISPOSABLE_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'testing.com',
  'correo.com',
  'email.com',
  'dominio.com',
  'midominio.com',
  'sincorreo.com',
  'nocorreo.com',
  'notiene.com',
  'ninguno.com',
  'falso.com',
  'fake.com',
  'noemail.com',
  'nomail.com',
  'none.com',
  'invalid.com',
  'localhost',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  '10minutemail.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'pokemail.net',
  'spam4.me',
  'trashmail.com',
  'fakeinbox.com',
  'maildrop.cc',
  'dispostable.com',
  'getnada.com',
  'nada.email',
  'mohmal.com',
  'mailnesia.com',
  'throwawaymail.com',
]);

const COMMON_DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.cmo': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'homtail.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
  'iclod.com': 'icloud.com',
  'icoud.com': 'icloud.com',
  'icloud.co': 'icloud.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
};

const BLOCKED_CUYPAY_LOCAL_PARTS = new Set([
  'usuario',
  'user',
  'cliente',
  'test',
  'prueba',
  'correo',
  'email',
  'demo',
  'sin',
  'no',
  'na',
  'none',
  'null',
]);

const BLOCKED_FAKE_LOCAL_PARTS = new Set([
  'notiene',
  'sincorreo',
  'nocorreo',
  'sinemail',
  'noemail',
  'ninguno',
  'ninguna',
]);

export function isPlaceholderEmail(raw?: string | null): boolean {
  const e = String(raw ?? '').trim().toLowerCase();
  return !e || e === 'usuario@cuypay.com' || e.endsWith('@pendiente.cuypay.com');
}

export function validateEmailSyntaxAndDomainRules(
  raw?: string | null,
  opts: { isLive?: boolean } = {},
): { valid: true; email: string; domain: string } | { valid: false; message: string } {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email || isPlaceholderEmail(email)) {
    return { valid: false, message: 'Ingresa tu correo electrónico personal real.' };
  }

  const match = EMAIL_FORMAT_RE.exec(email);
  if (!match) {
    return { valid: false, message: 'El formato del correo electrónico no es válido.' };
  }

  const atIdx = email.lastIndexOf('@');
  const localPart = email.slice(0, atIdx);
  const domain = match[1]!.toLowerCase();

  if (COMMON_DOMAIN_TYPOS[domain]) {
    return {
      valid: false,
      message: `El dominio @${domain} tiene un error de escritura. ¿Quisiste decir ${localPart}@${COMMON_DOMAIN_TYPOS[domain]}?`,
    };
  }

  if (
    BLOCKED_GENERIC_OR_DISPOSABLE_DOMAINS.has(domain) ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.local') ||
    domain.endsWith('.example') ||
    domain.endsWith('.test')
  ) {
    return {
      valid: false,
      message: 'Usa un correo electrónico personal real y permanente (no se permiten correos temporales ni genéricos).',
    };
  }

  if (opts.isLive && domain.endsWith('.cuypay.com')) {
    return {
      valid: false,
      message: 'Ingresa tu correo electrónico personal real para recibir códigos de seguridad.',
    };
  }

  if (domain === 'cuypay.com' && BLOCKED_CUYPAY_LOCAL_PARTS.has(localPart)) {
    return {
      valid: false,
      message: 'Ingresa tu correo electrónico personal real (no un correo genérico).',
    };
  }

  if (BLOCKED_FAKE_LOCAL_PARTS.has(localPart)) {
    return {
      valid: false,
      message: 'Ingresa un correo electrónico real al que tengas acceso.',
    };
  }

  return { valid: true, email, domain };
}

export interface DeliverableEmailOptions {
  isLive?: boolean;
  resolveMxImpl?: (domain: string) => Promise<MxRecord[]>;
}

const DNS_FATAL_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EBADNAME', 'ESERVFAIL', 'EREFUSED']);

/**
 * Verifica que el correo no sea placeholder/genérico/temporal/typo y, cuando `isLive` es true,
 * comprueba mediante DNS MX que el dominio realmente exista y pueda recibir correos.
 */
export async function assertDeliverableEmail(raw: string, opts: DeliverableEmailOptions = {}): Promise<string> {
  const staticCheck = validateEmailSyntaxAndDomainRules(raw, { isLive: opts.isLive });
  if (!staticCheck.valid) {
    throw new AppError('VALIDATION_ERROR', staticCheck.message, { field: 'email' });
  }

  if (!opts.isLive) {
    return staticCheck.email;
  }

  const resolveMxFn = opts.resolveMxImpl ?? dns.resolveMx;
  let records: MxRecord[] | null = null;
  try {
    records = await Promise.race([
      resolveMxFn(staticCheck.domain),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
    ]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    if (DNS_FATAL_CODES.has(code)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Ese correo electrónico no existe (el dominio @${staticCheck.domain} no recibe mensajes). Verifica que esté bien escrito.`,
        { field: 'email', reason: 'mx_not_found' },
      );
    }
    // Si hubo un timeout transitorio de red DNS no bloqueamos dominios legítimos.
    return staticCheck.email;
  }

  // `records === null` indica timeout de 3.5s (permitimos continuar). Si resolvió lista vacía o Null MX (RFC 7505), rechazamos.
  if (records !== null) {
    const validMx = records.filter((r) => r.exchange && r.exchange !== '.' && r.exchange.trim() !== '');
    if (validMx.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Ese correo electrónico no puede recibir mensajes (el dominio @${staticCheck.domain} no tiene buzón de correo activo).`,
        { field: 'email', reason: 'null_mx' },
      );
    }
  }

  return staticCheck.email;
}
