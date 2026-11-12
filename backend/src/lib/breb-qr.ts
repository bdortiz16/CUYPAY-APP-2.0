/**
 * Decodificador y normalizador de códigos QR interoperables Bre-B / EMVCo Colombia
 * (Estándar EASPBV Colombianas — ACH / Redeban / Credibanco / Banco de la República v1.5).
 *
 * Soporta:
 *  - QR EMVCo Merchant-Presented Mode (`000201...6304XXXX`):
 *      * Tag 26 (y templates 26–48 con GUI `*.LLA`, `BREB`, `BANREP`, `BRC`, `ALIAS`, etc.):
 *          - Subtag 01: Identificación (CC, CE, NIT, Pasaporte, NUIP)
 *          - Subtag 02: Número celular
 *          - Subtag 03: Correo electrónico
 *          - Subtag 04: Llave alfanumérica (@alias)
 *          - Subtag 05: Merchant ID / Código de comercio
 *      * Tag 50 (`CO.COM.RBM.CU` / `CO.COM.CRB.CU`):
 *          - Subtag 01: Código Único del Comercio (llave de comercio Bre-B, 10 dígitos)
 *      * Tag 52: MCC (categoría de comercio)
 *      * Tag 53: Moneda ISO 4217 (`170` = COP)
 *      * Tag 54: Monto de la transacción (en pesos COP → unidades menores)
 *      * Tag 59 / Tag 64.01: Nombre del comercio o titular
 *      * Tag 60 / Tag 64.02: Ciudad
 *      * Tag 62: Datos adicionales (01 factura, 02 celular, 05 referencia, 10 NIT)
 *      * Tag 63: CRC-16/CCITT-FALSE
 *  - Enlaces (`https://`, `cuypay://`, `breb://`, `mailto:`, `tel:`)
 *  - Llaves Bre-B directas (`@alias`, celular `+57...`/`300...`, documento/NIT, código de comercio `00...`, correo).
 */

export interface EmvTlvEntry {
  tag: string;
  value: string;
}

export interface ParsedBrebQr {
  raw: string;
  isEmvCo: boolean;
  crcValid: boolean | null;
  initiationMethod: 'static' | 'dynamic' | null;
  primaryKey: string | null;
  candidateKeys: string[];
  isMerchant: boolean;
  merchantName: string | null;
  merchantCity: string | null;
  currencyCode: string | null;
  amountMinor: number | null;
  reference: string | null;
  unsupportedReason: string | null;
}

const NON_KEY_GUI_SUFFIXES = [
  '.red',
  '.ca',
  '.sec',
  '.canal',
  '.civa',
  '.iva',
  '.base',
  '.cinc',
  '.inc',
  '.trxid',
  '.desc',
];

const KNOWN_NETWORK_CODES = new Set([
  'ACH',
  'BRC',
  'CRB',
  'RBM',
  'SVB',
  'VISI',
  'GOU',
  'MCCA',
  'VCSS',
]);

/** Calcula el CRC-16/CCITT-FALSE (polinomio 0x1021, valor inicial 0xFFFF) en mayúsculas hexadecimales. */
export function computeEmvCrc16(payloadUpTo6304: string): string {
  const bytes = Buffer.from(payloadUpTo6304, 'utf8');
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Parsea una secuencia TLV EMVCo (`[tag:2][len:2][value:len]`) sobre puntos de código Unicode. */
export function parseEmvTlvs(input: string): EmvTlvEntry[] | null {
  const chars = Array.from(input);
  const entries: EmvTlvEntry[] = [];
  let idx = 0;

  while (idx < chars.length) {
    if (idx + 4 > chars.length) return entries.length > 0 ? entries : null;
    const tag = chars.slice(idx, idx + 2).join('');
    const lenStr = chars.slice(idx + 2, idx + 4).join('');
    if (!/^[0-9A-Za-z]{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) {
      return entries.length > 0 ? entries : null;
    }
    const len = Number.parseInt(lenStr, 10);
    idx += 4;
    if (len === 0) {
      entries.push({ tag, value: '' });
      continue;
    }
    if (idx + len > chars.length) {
      return entries.length > 0 ? entries : null;
    }
    const value = chars.slice(idx, idx + len).join('');
    entries.push({ tag, value });
    idx += len;
    if (tag === '63') break;
  }

  return entries.length > 0 ? entries : null;
}

/** Normaliza una llave candidata individual según su naturaleza (celular, alias @, correo, comercio, documento). */
export function normalizeBrebKeyCandidate(
  raw: string,
  hint?: 'id' | 'phone' | 'email' | 'alias' | 'merchant' | 'auto',
): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;

  // Descartar URLs crudas como llave directa
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  if (hint === 'email' || (!trimmed.startsWith('@') && trimmed.includes('@'))) {
    const email = trimmed.toLowerCase().replace(/\s+/g, '');
    const parts = email.split('@');
    if (parts.length === 2 && parts[0] && parts[1] && parts[1].includes('.') && !parts[1].endsWith('.')) {
      return email;
    }
    return null;
  }

  if (hint === 'alias' || trimmed.startsWith('@')) {
    const clean = trimmed.replace(/^@+/, '').trim().toLowerCase();
    if (!clean || clean.length > 63) return null;
    if (!/^[a-z0-9._-]+$/.test(clean)) return null;
    return `@${clean}`;
  }

  if (hint === 'phone') {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('573')) return digits.slice(2);
    if (digits.length >= 10 && digits.length <= 15) return digits;
    return null;
  }

  if (hint === 'merchant') {
    const cleaned = trimmed.replace(/[\s-]/g, '');
    if (/^\d{5,15}$/.test(cleaned)) return cleaned;
    if (/^[A-Za-z0-9._-]{4,40}$/.test(cleaned)) return cleaned;
    return null;
  }

  if (hint === 'id') {
    const cleaned = trimmed.replace(/[\s.-]/g, '');
    if (/^\d{5,15}$/.test(cleaned)) return cleaned;
    if (/^[A-Za-z0-9]{5,20}$/.test(cleaned)) return cleaned.toUpperCase();
    return null;
  }

  // Modo automático (`auto`)
  // 1) Celular colombiano con indicativo +57 / 57
  const compactPhone = trimmed.replace(/[\s()-]/g, '');
  if (/^\+?573\d{9}$/.test(compactPhone)) {
    return compactPhone.replace(/^\+?57/, '');
  }
  if (/^\+\d{10,15}$/.test(compactPhone)) {
    return compactPhone.slice(1);
  }

  // 2) Solo dígitos (celular 10 dígitos, cédula, NIT o código de comercio de 5 a 15 dígitos)
  const compactDigits = trimmed.replace(/[\s-]/g, '');
  if (/^\d{5,15}$/.test(compactDigits)) {
    if (compactDigits.length === 12 && compactDigits.startsWith('573')) {
      return compactDigits.slice(2);
    }
    return compactDigits;
  }

  // 3) Alfanumérico sin espacios (alias sin @ o pasaporte / llave corporativa)
  if (/^[A-Za-z0-9._-]{3,63}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function parseMajorAmountToCopMinor(rawAmount: string | undefined): number | null {
  if (!rawAmount) return null;
  const cleaned = rawAmount.trim().replace(/,/g, '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [intPart = '0', fracPart = ''] = cleaned.split('.');
  const major = Number.parseInt(intPart, 10);
  const cents = Number.parseInt(fracPart.padEnd(2, '0').slice(0, 2), 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(cents)) return null;
  const minor = major * 100 + cents;
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

function cleanEmvText(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();
  if (upper === 'NA' || upper === 'N/A' || upper === '***' || upper === '*' || /^0+$/.test(upper)) {
    return null;
  }
  return cleaned;
}

function extractFromUrl(raw: string): ParsedBrebQr | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const proto = url.protocol.toLowerCase();
  if (proto === 'mailto:') {
    const email = normalizeBrebKeyCandidate(decodeURIComponent(url.pathname), 'email');
    return {
      raw,
      isEmvCo: false,
      crcValid: null,
      initiationMethod: null,
      primaryKey: email,
      candidateKeys: email ? [email] : [],
      isMerchant: false,
      merchantName: null,
      merchantCity: null,
      currencyCode: 'COP',
      amountMinor: null,
      reference: null,
      unsupportedReason: email ? null : 'El código QR no contiene un correo válido para Bre-B.',
    };
  }

  if (proto === 'tel:') {
    const phone = normalizeBrebKeyCandidate(decodeURIComponent(url.pathname), 'phone');
    return {
      raw,
      isEmvCo: false,
      crcValid: null,
      initiationMethod: null,
      primaryKey: phone,
      candidateKeys: phone ? [phone] : [],
      isMerchant: false,
      merchantName: null,
      merchantCity: null,
      currencyCode: 'COP',
      amountMinor: null,
      reference: null,
      unsupportedReason: phone ? null : 'El código QR no contiene un celular válido para Bre-B.',
    };
  }

  // Revisar si algún parámetro de la URL es a su vez un payload EMVCo (ej. `?qr=000201...`)
  for (const paramName of ['qr', 'emv', 'payload', 'data', 'code']) {
    const nested = url.searchParams.get(paramName);
    if (nested && nested.trim().startsWith('0002')) {
      return parseBrebQrPayload(nested.trim());
    }
  }

  const candidates: string[] = [];
  const pushCandidate = (v: string | null) => {
    if (v && !candidates.includes(v)) candidates.push(v);
  };

  for (const paramName of ['key', 'alias', 'llave', 'breb', 'to', 'recipient', 'phone', 'celular', 'merchant', 'comercio']) {
    const val = url.searchParams.get(paramName);
    if (val) {
      const hint =
        paramName === 'alias'
          ? 'alias'
          : paramName === 'phone' || paramName === 'celular'
            ? 'phone'
            : paramName === 'merchant' || paramName === 'comercio'
              ? 'merchant'
              : 'auto';
      pushCandidate(normalizeBrebKeyCandidate(val, hint));
    }
  }

  // Rutas tipo https://cuypay.com/@alias o breb://pay/@alias
  const segments = url.pathname
    .split('/')
    .map((s) => decodeURIComponent(s).trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.startsWith('@')) {
      pushCandidate(normalizeBrebKeyCandidate(seg, 'alias'));
    } else if ((proto === 'cuypay:' || proto === 'breb:') && seg.toLowerCase() !== 'pay' && seg.toLowerCase() !== 'send') {
      pushCandidate(normalizeBrebKeyCandidate(seg, 'auto'));
    }
  }

  if ((proto === 'cuypay:' || proto === 'breb:') && url.hostname && url.hostname.toLowerCase() !== 'pay' && url.hostname.toLowerCase() !== 'send') {
    pushCandidate(normalizeBrebKeyCandidate(decodeURIComponent(url.hostname), 'auto'));
  }

  const amountMinor = parseMajorAmountToCopMinor(
    url.searchParams.get('amount') ?? url.searchParams.get('monto') ?? url.searchParams.get('valor') ?? undefined,
  );
  const reference = cleanEmvText(
    url.searchParams.get('ref') ?? url.searchParams.get('reference') ?? url.searchParams.get('referencia') ?? undefined,
  );
  const merchantName = cleanEmvText(url.searchParams.get('name') ?? url.searchParams.get('nombre') ?? undefined);

  return {
    raw,
    isEmvCo: false,
    crcValid: null,
    initiationMethod: amountMinor ? 'dynamic' : null,
    primaryKey: candidates[0] ?? null,
    candidateKeys: candidates,
    isMerchant: Boolean(url.searchParams.get('merchant') || url.searchParams.get('comercio')),
    merchantName,
    merchantCity: null,
    currencyCode: 'COP',
    amountMinor,
    reference,
    unsupportedReason:
      candidates.length > 0 ? null : 'Este código QR contiene un enlace web que no incluye una llave Bre-B.',
  };
}

/**
 * Decodifica cualquier cadena leída desde un QR o pegada por el usuario y extrae la llave Bre-B
 * principal, llaves alternativas de respaldo (ej. Tag 26 → Tag 50 Código Comercio → Tag 62),
 * nombre del comercio/cliente, monto sugerido y referencia.
 */
export function parseBrebQrPayload(rawInput: string): ParsedBrebQr {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      raw: '',
      isEmvCo: false,
      crcValid: null,
      initiationMethod: null,
      primaryKey: null,
      candidateKeys: [],
      isMerchant: false,
      merchantName: null,
      merchantCity: null,
      currencyCode: null,
      amountMinor: null,
      reference: null,
      unsupportedReason: 'El código QR está vacío.',
    };
  }

  // 1. Detectar EMVCo Merchant-Presented Mode (`00` = Payload Format Indicator al inicio)
  if (/^00\d{2}0[12]/.test(trimmed)) {
    const tlvs = parseEmvTlvs(trimmed);
    if (tlvs && tlvs.some((t) => t.tag === '00')) {
      const map = new Map<string, string>();
      for (const entry of tlvs) {
        if (!map.has(entry.tag)) map.set(entry.tag, entry.value);
      }

      // Verificar CRC-16 si el tag 63 está al final
      let crcValid: boolean | null = null;
      const crcMatch = /^(.*6304)([0-9A-Fa-f]{4})$/.exec(trimmed);
      if (crcMatch) {
        const expected = computeEmvCrc16(crcMatch[1]!);
        crcValid = expected === crcMatch[2]!.toUpperCase();
      }

      const pointOfInitiation = map.get('01');
      const initiationMethod: 'static' | 'dynamic' | null =
        pointOfInitiation === '11' ? 'static' : pointOfInitiation === '12' ? 'dynamic' : null;

      const candidates: string[] = [];
      const pushCandidate = (key: string | null) => {
        if (key && !candidates.includes(key)) candidates.push(key);
      };

      let hasMerchantCode = false;

      // Recolectar templates 26..51
      const templates: Array<{ tagNum: number; gui: string; subs: EmvTlvEntry[] }> = [];
      for (const entry of tlvs) {
        const tagNum = Number.parseInt(entry.tag, 10);
        if (tagNum >= 26 && tagNum <= 51) {
          const subs = parseEmvTlvs(entry.value);
          if (subs && subs.length > 0) {
            const gui = (subs.find((s) => s.tag === '00')?.value ?? '').trim().toLowerCase();
            templates.push({ tagNum, gui, subs });
          }
        }
      }

      const extractMultillaveSubs = (subs: EmvTlvEntry[], gui: string) => {
        for (const sub of subs) {
          if (sub.tag === '00' || !sub.value.trim()) continue;
          const val = sub.value.trim();

          // Si un subtag contiene URL con parámetro de llave, extraerlo
          if (/^https?:\/\//i.test(val)) {
            const fromUrl = extractFromUrl(val);
            if (fromUrl) {
              for (const k of fromUrl.candidateKeys) pushCandidate(k);
            }
            continue;
          }

          if (KNOWN_NETWORK_CODES.has(val.toUpperCase())) continue;

          // En estándar colombiano EASPBV (`*.lla`):
          // 01 = Identificación, 02 = Celular, 03 = Correo, 04 = Alfanumérico (@alias), 05 = Merchant ID
          const isColombianLla =
            gui.endsWith('.lla') || gui.includes('breb') || gui.includes('bre-b') || gui.includes('banrep');

          if (isColombianLla) {
            switch (sub.tag) {
              case '01':
                pushCandidate(normalizeBrebKeyCandidate(val, 'id'));
                break;
              case '02':
                pushCandidate(normalizeBrebKeyCandidate(val, 'phone'));
                break;
              case '03':
                pushCandidate(normalizeBrebKeyCandidate(val, 'email'));
                break;
              case '04': {
                const alias = normalizeBrebKeyCandidate(val, 'alias');
                pushCandidate(alias);
                // Respaldo sin @ por si el directorio lo registró como código alfanumérico directo
                if (!val.startsWith('@')) {
                  pushCandidate(normalizeBrebKeyCandidate(val, 'auto'));
                }
                break;
              }
              case '05': {
                hasMerchantCode = true;
                const mKey = normalizeBrebKeyCandidate(val, 'merchant');
                pushCandidate(mKey);
                if (mKey && /^\d{6,9}$/.test(mKey)) {
                  pushCandidate(mKey.padStart(10, '0'));
                }
                break;
              }
              default:
                pushCandidate(normalizeBrebKeyCandidate(val, 'auto'));
                break;
            }
          } else {
            // Otros proveedores (ej. Coinsenda, Pix, billeteras con GUI propio en tag 26..48)
            const auto = normalizeBrebKeyCandidate(val, 'auto');
            if (auto) {
              if (!auto.startsWith('@') && !auto.includes('@') && /[a-zA-Z]/.test(auto)) {
                pushCandidate(`@${auto.toLowerCase()}`);
              }
              pushCandidate(auto);
            }
          }
        }
      };

      // Prioridad 1: Templates explícitos de llave Bre-B (`*.lla`, `breb`, `banrep`) o Tag 26 estándar
      for (const tpl of templates) {
        const isExplicitKeyGui =
          tpl.gui.endsWith('.lla') ||
          tpl.gui.includes('breb') ||
          tpl.gui.includes('bre-b') ||
          tpl.gui.includes('banrep') ||
          tpl.gui.includes('alias') ||
          tpl.gui.includes('llave');
        const isNonKey = NON_KEY_GUI_SUFFIXES.some((sfx) => tpl.gui.endsWith(sfx)) || tpl.gui.endsWith('.cu');
        if (isExplicitKeyGui || (tpl.tagNum === 26 && !isNonKey)) {
          extractMultillaveSubs(tpl.subs, tpl.gui);
        }
      }

      // Prioridad 2: Código Único del Comercio en Tag 50 o GUI `*.cu` (estándar EASPBV: fallback oficial tras Tag 26)
      for (const tpl of templates) {
        if (tpl.tagNum === 50 || tpl.gui.endsWith('.cu')) {
          for (const sub of tpl.subs) {
            if (sub.tag === '00' || !sub.value.trim()) continue;
            const rawCu = sub.value.trim();
            const cu = normalizeBrebKeyCandidate(rawCu, 'merchant');
            if (cu) {
              hasMerchantCode = true;
              pushCandidate(cu);
              if (/^\d{6,9}$/.test(cu)) {
                pushCandidate(cu.padStart(10, '0'));
              }
            }
          }
        }
      }

      // Prioridad 3: Otros templates en 27..48 que no sean redes (.red) ni agregadores (.ca)
      for (const tpl of templates) {
        const isNonKey = NON_KEY_GUI_SUFFIXES.some((sfx) => tpl.gui.endsWith(sfx)) || tpl.gui.endsWith('.cu');
        if (tpl.tagNum >= 27 && tpl.tagNum <= 48 && !isNonKey) {
          extractMultillaveSubs(tpl.subs, tpl.gui);
        }
      }

      // Datos adicionales en Tag 62 y idioma alternativo en Tag 64
      const additionalSubs = map.has('62') ? parseEmvTlvs(map.get('62')!) ?? [] : [];
      const langSubs = map.has('64') ? parseEmvTlvs(map.get('64')!) ?? [] : [];

      const getSub = (subs: EmvTlvEntry[], subTag: string) => subs.find((s) => s.tag === subTag)?.value;

      // Prioridad 4: Respaldo desde Tag 62 (02 = Celular comercio/cliente, 10 = NIT comercio)
      const mobile62 = getSub(additionalSubs, '02');
      if (mobile62) {
        pushCandidate(normalizeBrebKeyCandidate(mobile62, 'phone'));
      }
      const nit62 = getSub(additionalSubs, '10');
      if (nit62) {
        hasMerchantCode = true;
        const cleanNit = nit62.replace(/\D/g, '');
        if (cleanNit.length >= 5 && cleanNit.length <= 15) {
          pushCandidate(cleanNit);
          // Si viene NIT de 10 dígitos con dígito de verificación, probar también los 9 dígitos base
          if (cleanNit.length === 10 && (cleanNit.startsWith('8') || cleanNit.startsWith('9'))) {
            pushCandidate(cleanNit.slice(0, 9));
          }
        }
      }

      const mcc = cleanEmvText(map.get('52'));
      const isMerchant =
        hasMerchantCode ||
        Boolean(nit62) ||
        Boolean(mcc && mcc !== '0000' && mcc !== '4829');

      const merchantName = cleanEmvText(getSub(langSubs, '01')) ?? cleanEmvText(map.get('59'));
      const merchantCity = cleanEmvText(getSub(langSubs, '02')) ?? cleanEmvText(map.get('60'));

      const rawCurrency = map.get('53')?.trim();
      const currencyCode = rawCurrency === '170' || !rawCurrency ? 'COP' : rawCurrency === '986' ? 'BRL' : rawCurrency;
      const amountMinor = currencyCode === 'COP' ? parseMajorAmountToCopMinor(map.get('54')) : null;

      const billingNumber = cleanEmvText(getSub(additionalSubs, '01'));
      const referenceLabel = cleanEmvText(getSub(additionalSubs, '05'));
      const reference = billingNumber ?? referenceLabel;

      return {
        raw: trimmed,
        isEmvCo: true,
        crcValid,
        initiationMethod,
        primaryKey: candidates[0] ?? null,
        candidateKeys: candidates,
        isMerchant,
        merchantName,
        merchantCity,
        currencyCode,
        amountMinor,
        reference,
        unsupportedReason:
          candidates.length > 0
            ? null
            : 'Este código QR no contiene una llave Bre-B interoperable. Solicita al comercio o destinatario su QR o llave Bre-B.',
      };
    }
  }

  // 2. Detectar URLs / esquemas (`https://`, `cuypay://`, `breb://`, `mailto:`, `tel:`)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    // Descartar esquemas no financieros comunes como WIFI:, BEGIN:VCARD, SMSTO:
    if (/^(wifi|begin|smsto|geo|matmsg):/i.test(trimmed)) {
      return {
        raw: trimmed,
        isEmvCo: false,
        crcValid: null,
        initiationMethod: null,
        primaryKey: null,
        candidateKeys: [],
        isMerchant: false,
        merchantName: null,
        merchantCity: null,
        currencyCode: null,
        amountMinor: null,
        reference: null,
        unsupportedReason: 'Este código QR no corresponde a un pago o llave Bre-B.',
      };
    }
    const urlParsed = extractFromUrl(trimmed);
    if (urlParsed) return urlParsed;
  }

  // 3. Llave directa en texto plano (`@alias`, celular, cédula/NIT, código de comercio `00...`, correo)
  const direct = normalizeBrebKeyCandidate(trimmed, 'auto');
  const candidates: string[] = [];
  if (direct) {
    candidates.push(direct);
    if (/^\d{10}$/.test(direct) && direct.startsWith('00')) {
      // Código de comercio de 10 dígitos en Bre-B
    } else if (!direct.startsWith('@') && !direct.includes('@') && /[a-zA-Z]/.test(direct)) {
      // Si es alfanumérico sin `@`, priorizar `@alias` y dejar el valor crudo como respaldo
      candidates.unshift(`@${direct.toLowerCase()}`);
    }
  }

  const isMerchant = Boolean(direct && /^\d{10}$/.test(direct) && direct.startsWith('00'));

  return {
    raw: trimmed,
    isEmvCo: false,
    crcValid: null,
    initiationMethod: null,
    primaryKey: candidates[0] ?? null,
    candidateKeys: candidates,
    isMerchant,
    merchantName: null,
    merchantCity: null,
    currencyCode: 'COP',
    amountMinor: null,
    reference: null,
    unsupportedReason: candidates.length > 0 ? null : 'Llave Bre-B o código QR no válido.',
  };
}
