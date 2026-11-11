import { createHash } from 'node:crypto';
import {
  ALLOWED_LOAN_TERMS,
  type ElectronicSignatureEvidence,
  type Loan,
  type LoanConfig,
  type LoanRateTier,
  type PromissoryNote,
  type Transaction,
  type User,
} from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { canonicalRequestString, sha256Hex } from '../lib/crypto.js';
import { isPlaceholderEmail } from '../lib/email-validator.js';
import { AppError } from '../lib/errors.js';
import type { AdminContext, AuditService } from './admin/audit.js';
import type { KeyedMutex, ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService, Leg } from './ledger.js';
import { assertNotFrozen } from './runtime-config.js';

export interface LoanPreviewInput {
  principalMinor: bigint;
  termDays: number;
  purpose?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  city?: string | null;
}

export interface LoanSignatureContext {
  deviceId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path: string;
  rawBody: Buffer | undefined;
  ip: string;
  userAgent: string;
}

export interface LoanApplyInput extends LoanPreviewInput {
  documentSha256: string;
  acceptedPagare: boolean;
  acceptedInstructionLetter: boolean;
  acceptedCreditBureauAuth: boolean;
}

function formatCop(minor: bigint): string {
  const major = Number(minor / 100n);
  const cents = Number(minor % 100n);
  const base = major.toLocaleString('es-CO');
  return cents > 0 ? `$${base},${String(cents).padStart(2, '0')} COP` : `$${base} COP`;
}

function normalizeDocTypeLabel(raw?: string | null): string {
  const clean = String(raw ?? '').trim().toUpperCase();
  if (clean === 'CE' || clean === 'CEDULA_EXTRANJERIA') return 'CE';
  if (clean === 'PPT') return 'PPT';
  if (clean === 'PEP') return 'PEP';
  if (clean === 'PASAPORTE' || clean === 'PASSPORT') return 'PASAPORTE';
  return 'CC';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function computeNominalMonthlyPercent(rateEaPercent: number): number {
  const monthly = (Math.pow(1 + rateEaPercent / 100, 1 / 12) - 1) * 100;
  return Math.round(monthly * 100) / 100;
}

/**
 * Calcula el interés remuneratorio compuesto equivalente para `termDays` de modo que la tasa
 * efectiva anual cobrada sea exactamente `rateEaPercent` E.A. y jamás supere el tope de usura SFC.
 */
function computeCompoundInterestMinor(principalMinor: bigint, rateEaPercent: number, termDays: number): bigint {
  const factor = Math.pow(1 + rateEaPercent / 100, termDays / 365) - 1;
  const raw = Math.round(Number(principalMinor) * factor);
  return BigInt(Math.max(1, raw));
}

function deterministicFallbackDocNumber(seed: string): string {
  const hex = createHash('sha256').update(`cuypay-pagare-doc:${seed}`).digest('hex');
  const digits = (BigInt(`0x${hex.slice(0, 14)}`) % 90_000_000n + 10_000_000n).toString();
  return `10${digits}`;
}

export class LoansService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly mutex: KeyedMutex,
    private readonly audit?: AuditService,
  ) {}

  async getConfig(): Promise<LoanConfig> {
    return this.d.repos.loanConfig.get();
  }

  async updateConfig(
    ctx: AdminContext | null,
    patch: {
      enabled?: boolean;
      rates?: LoanRateTier[];
      usuryCeilingEaPercent?: number;
      moratoryRateEaPercent?: number;
      minAmountMinor?: bigint;
      maxAmountMinor?: bigint;
    },
    reason = 'Actualización de parámetros de crédito',
  ): Promise<LoanConfig> {
    const current = await this.d.repos.loanConfig.get();
    const usuryCeiling = patch.usuryCeilingEaPercent ?? current.usuryCeilingEaPercent;
    if (usuryCeiling <= 0 || usuryCeiling > 60) {
      throw new AppError('VALIDATION_ERROR', 'El tope de usura E.A. debe estar entre 0.1% y 60%');
    }

    const moratory = patch.moratoryRateEaPercent ?? Math.min(current.moratoryRateEaPercent, usuryCeiling);
    if (moratory <= 0 || moratory > usuryCeiling) {
      throw new AppError(
        'VALIDATION_ERROR',
        `La tasa moratoria (${moratory}% E.A.) no puede superar el tope de usura vigente (${usuryCeiling}% E.A.) certificado por la Superfinanciera.`,
      );
    }

    const nextRates = (patch.rates ?? current.rates).map((r) => ({
      termDays: Number(r.termDays),
      rateEaPercent: Number(r.rateEaPercent),
      enabled: Boolean(r.enabled),
    }));

    for (const r of nextRates) {
      if (!ALLOWED_LOAN_TERMS.includes(r.termDays as (typeof ALLOWED_LOAN_TERMS)[number])) {
        throw new AppError('VALIDATION_ERROR', `Plazo inválido: ${r.termDays}. Permitidos: 30, 60, 90, 180 y 360 días.`);
      }
      if (r.rateEaPercent <= 0 || r.rateEaPercent > usuryCeiling) {
        throw new AppError(
          'VALIDATION_ERROR',
          `La tasa del plazo ${r.termDays} días (${r.rateEaPercent}% E.A.) supera el límite legal de usura (${usuryCeiling}% E.A. — Art. 884 C.Co. y Art. 305 C.P.).`,
        );
      }
    }

    const minAmountMinor = patch.minAmountMinor ?? current.minAmountMinor;
    const maxAmountMinor = patch.maxAmountMinor ?? current.maxAmountMinor;
    if (minAmountMinor <= 0n || maxAmountMinor < minAmountMinor) {
      throw new AppError('VALIDATION_ERROR', 'Rango de montos de crédito inválido');
    }

    const updated: LoanConfig = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      rates: nextRates,
      usuryCeilingEaPercent: usuryCeiling,
      moratoryRateEaPercent: moratory,
      minAmountMinor,
      maxAmountMinor,
      updatedAt: this.d.clock.now(),
      updatedBy: ctx?.admin.email ?? 'admin@cuypay.com',
    };

    await this.d.repos.loanConfig.set(updated);
    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'loans.config_update',
        targetType: 'loan_config',
        targetId: 'COP',
        reason,
        before: {
          enabled: current.enabled,
          rates: current.rates,
          usuryCeilingEaPercent: current.usuryCeilingEaPercent,
        },
        after: {
          enabled: updated.enabled,
          rates: updated.rates,
          usuryCeilingEaPercent: updated.usuryCeilingEaPercent,
        },
      });
    }
    return updated;
  }

  private async resolveDebtorProfile(
    user: User,
    override?: { documentType?: string | null; documentNumber?: string | null; city?: string | null },
  ) {
    const kycRec = await this.d.repos.kyc.byUser(user.id);
    const kycProfile = this.d.kyc.getApplicantProfile
      ? await this.d.kyc
          .getApplicantProfile({
            applicantId: kycRec?.applicantId ?? null,
            externalUserId: user.id,
          })
          .catch(() => null)
      : null;

    const fullNameFromKyc =
      kycProfile && !kycProfile.isSandboxMockDocument
        ? `${kycProfile.firstName} ${kycProfile.lastName}`.trim()
        : '';
    const userFullName = `${user.firstName} ${user.lastName}`.trim();
    const isPlaceholderName =
      user.firstName.trim().toLowerCase() === 'usuario' && user.lastName.trim().toLowerCase() === 'cuypay';
    const debtorFullName = fullNameFromKyc || (!isPlaceholderName ? userFullName : '') || userFullName;

    const debtorEmail = (user.email || kycProfile?.verifiedEmailFromKyc || kycProfile?.email || '').trim().toLowerCase();
    const debtorPhone = (user.phone || kycProfile?.verifiedPhoneFromKyc || kycProfile?.phone || '').trim();

    if (!debtorEmail || isPlaceholderEmail(debtorEmail)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Debes tener un correo electrónico real verificado en tu Perfil antes de solicitar un crédito y firmar tu Pagaré electrónico.',
        { field: 'email' },
      );
    }
    if (!debtorPhone) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Debes tener tu número de celular verificado en tu Perfil antes de solicitar un crédito.',
        { field: 'phone' },
      );
    }

    const isSandboxOrMock =
      !kycProfile ||
      kycProfile.isSandboxMockDocument ||
      this.d.config.PROVIDERS_MODE !== 'live' ||
      Boolean(this.d.config.SUMSUB_APP_TOKEN?.startsWith('sbx:'));

    let docType = kycProfile?.documentNumber
      ? normalizeDocTypeLabel(kycProfile.documentType)
      : normalizeDocTypeLabel(override?.documentType);
    let docNumber = kycProfile?.documentNumber?.trim() || null;

    if (!docNumber && override?.documentNumber) {
      const cleaned = override.documentNumber.trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
      if (cleaned.length >= 5 && cleaned.length <= 16) {
        docNumber = cleaned;
      }
    }
    if (!docNumber) {
      const brebKeys = await this.d.repos.brebKeys.listByUser(user.id);
      const natKey = brebKeys.find((k) => k.type === 'national_id' && /^\d{6,11}$/.test(k.alias.replace(/^@/, '')));
      if (natKey) {
        docNumber = natKey.alias.replace(/^@/, '');
        docType = 'CC';
      }
    }
    if (!docNumber && isSandboxOrMock) {
      docNumber = deterministicFallbackDocNumber(`${user.id}:${debtorEmail}:${debtorPhone}`);
    }
    if (!docNumber) {
      throw new AppError(
        'KYC_REQUIRED',
        'No encontramos un número de documento verificado en Sumsub. Ingresa tu número de documento de identidad para generar el Pagaré.',
        { field: 'documentNumber' },
      );
    }

    const city =
      override?.city?.trim() ||
      kycProfile?.address?.city?.trim() ||
      'Bogotá D.C.';

    return {
      debtorFullName,
      debtorDocumentType: docType,
      debtorDocumentNumber: docNumber,
      debtorEmail,
      debtorPhone,
      debtorCity: city,
      sumsubApplicantId: kycProfile?.applicantId ?? kycRec?.applicantId ?? null,
    };
  }

  private buildLegalContractMarkdown(params: {
    config: LoanConfig;
    debtorFullName: string;
    debtorDocumentType: string;
    debtorDocumentNumber: string;
    debtorEmail: string;
    debtorPhone: string;
    debtorCity: string;
    principalMinor: bigint;
    interestMinor: bigint;
    totalDueMinor: bigint;
    termDays: number;
    rateEaPercent: number;
    nominalMonthlyPercent: number;
    moratoryRateEaPercent: number;
    purpose: string | null;
  }): string {
    const {
      config,
      debtorFullName,
      debtorDocumentType,
      debtorDocumentNumber,
      debtorEmail,
      debtorPhone,
      debtorCity,
      principalMinor,
      interestMinor,
      totalDueMinor,
      termDays,
      rateEaPercent,
      nominalMonthlyPercent,
      moratoryRateEaPercent,
      purpose,
    } = params;

    return [
      `# INSTRUMENTO INTEGRAL DE CRÉDITO COMERCIAL, PAGARÉ ELECTRÓNICO A LA ORDEN Y CARTA DE INSTRUCCIONES`,
      ``,
      `**ACREEDOR:** ${config.creditorLegalName} — NIT ${config.creditorNit}`,
      `**DOMICILIO DEL ACREEDOR Y LUGAR DE CUMPLIMIENTO:** ${config.creditorDomicile}`,
      `**DEUDOR(A):** ${debtorFullName}`,
      `**IDENTIFICACIÓN:** ${debtorDocumentType} Nº ${debtorDocumentNumber}`,
      `**CONTACTO VERIFICADO:** ${debtorPhone} · ${debtorEmail} · ${debtorCity}, Colombia`,
      ``,
      `---`,
      ``,
      `## I. INFORMACIÓN PRECONTRACTUAL Y RESUMEN DE CONDICIONES FINANCIERAS`,
      `*(En cumplimiento del Artículo 45 de la Ley 1480 de 2011 — Estatuto del Consumidor y el Decreto 1368 de 2014)*`,
      ``,
      `- **Capital Solicitado (Principal):** ${formatCop(principalMinor)}`,
      `- **Plazo Único Seleccionado:** ${termDays} días calendario contados desde la fecha y hora exacta de desembolso`,
      `- **Tasa de Interés Remuneratoria Fija:** ${rateEaPercent.toFixed(2)}% Efectivo Anual (E.A.) — equivalente a ${nominalMonthlyPercent.toFixed(2)}% Nominal Mensual Vencido (N.M.V.)`,
      `- **Tasa de Referencia / Tope Legal de Usura Vigente (SFC):** ${config.usuryCeilingEaPercent.toFixed(2)}% E.A. (Art. 884 Código de Comercio)`,
      `- **Tasa de Interés Moratoria Máxima Aplicable:** Hasta el máximo legal permitido certificado por la Superintendencia Financiera de Colombia a la fecha de liquidación (referencia actual: ${moratoryRateEaPercent.toFixed(2)}% E.A.), liquidada exclusivamente sobre el capital vencido y nunca de forma simultánea con el interés remuneratorio`,
      `- **Estudio de Crédito, Seguros, Administración y Manejo:** $0 COP`,
      `- **Cobro de 4x1000 en plataforma CuyPay:** $0 COP`,
      `- **Intereses Remuneratorios Totales del Plazo:** ${formatCop(interestMinor)}`,
      `- **VALOR TOTAL UNIFICADO A PAGAR AL VENCIMIENTO:** ${formatCop(totalDueMinor)}`,
      `- **Destino declarado:** ${purpose?.trim() || 'Libre inversión / capital de trabajo personal'}`,
      `- **Derecho a Pago Anticipado:** El(La) Deudor(a) podrá realizar pagos anticipados parciales o totales en cualquier momento sin penalidad, sanción ni cobro compensatorio alguno (Art. 45 num. 4 Ley 1480 de 2011).`,
      ``,
      `---`,
      ``,
      `## II. CONTRATO DE MUTUO COMERCIAL CON RECURSOS PROPIOS`,
      `*(Artículos 1163 a 1169 del Código de Comercio y Artículos 2221 y siguientes del Código Civil Colombiano)*`,
      ``,
      `1. **Origen de los Recursos:** El presente crédito mercantil es otorgado por **${config.creditorLegalName}** exclusivamente con recursos propios de su patrimonio empresarial destinados a cartera de préstamos, sin que medie captación masiva y habitual de dineros del público.`,
      `2. **Perfeccionamiento y Desembolso:** La presente solicitud queda sujeta a verificación y aprobación por parte del comité de crédito del Acreedor. El contrato de mutuo se perfecciona única y exclusivamente en el instante en que **${config.creditorLegalName}** apruebe la solicitud y acredite efectivamente la suma de **${formatCop(principalMinor)}** en la cuenta/billetera digital CuyPay de titularidad del(de la) Deudor(a). En caso de rechazo de la solicitud, el presente instrumento quedará anulado de pleno derecho sin generar obligación alguna a cargo del(de la) solicitante.`,
      `3. **Imputación de Pagos:** Todo abono efectuado por el(la) Deudor(a) se imputará en el orden previsto en el Artículo 1653 del Código Civil Colombiano: primero a intereses causados y luego a capital.`,
      ``,
      `---`,
      ``,
      `## III. PAGARÉ ELECTRÓNICO A LA ORDEN`,
      `*(Artículos 621, 622 y 709 del Código de Comercio y Artículo 422 del Código General del Proceso)*`,
      ``,
      `Yo, **${debtorFullName}**, mayor de edad, identificado(a) con **${debtorDocumentType} Nº ${debtorDocumentNumber}**, domiciliado(a) en ${debtorCity}, República de Colombia, actuando en nombre propio en calidad de **DEUDOR(A)**, por medio del presente título valor electrónico declaro:`,
      ``,
      `**PRIMERO — PROMESA INCONDICIONAL DE PAGO:** Que **PAGARÉ INCONDICIONALMENTE**, de manera indivisible, solidaria y en dinero efectivo de curso legal (Pesos Colombianos — COP), **A LA ORDEN DE ${config.creditorLegalName}** (NIT **${config.creditorNit}**), o a la orden de quien represente sus derechos o sea tenedor legítimo del presente título valor por endoso o cesión, en la ciudad de **${config.creditorDomicile}** (o a través de los canales electrónicos dispuestos en la plataforma CuyPay), las siguientes sumas ciertas de dinero:`,
      `a) Por concepto de capital insoluto desembolsado, hasta la suma principal de **${formatCop(principalMinor)}** (o el saldo insoluto que resulte al diligenciar el presente título conforme a la Carta de Instrucciones);`,
      `b) Por concepto de intereses remuneratorios causados durante el plazo de **${termDays} días calendario**, liquidados a la tasa fija del **${rateEaPercent.toFixed(2)}% E.A.**, equivalentes a **${formatCop(interestMinor)}**;`,
      `c) En caso de retardo o mora, intereses moratorios sobre el saldo de capital vencido liquidados a la tasa máxima legal permitida certificada por la Superintendencia Financiera de Colombia para el respectivo período de mora, sin exceder en ningún caso el límite legal de usura.`,
      ``,
      `**SEGUNDO — VENCIMIENTO Y CLÁUSULA ACELERATORIA:** El plazo total para el pago vencerá cumplidos **${termDays} días calendario** contados a partir de la fecha y hora exacta de desembolso efectivo. El tenedor legítimo podrá declarar insubsistente el plazo y exigir judicial o extrajudicialmente de inmediato la totalidad de la obligación insoluta en cualquiera de los siguientes eventos: (i) incumplimiento total o parcial en el pago al vencimiento; (ii) suministro de información falsa o adulterada en el proceso de vinculación o estudio; (iii) persecución judicial, embargo o insolvencia que afecte sustancialmente la garantía general del patrimonio del(de la) Deudor(a).`,
      ``,
      `**TERCERO — RENUNCIA A REQUERIMIENTOS Y MÉRITO EJECUTIVO:** El(La) Deudor(a) renuncia expresamente al requerimiento judicial o privado para ser constituido(a) en mora (Art. 1608 del Código Civil y Art. 780 del Código de Comercio), así como a la presentación para el pago y avisos de rechazo, reconociendo que el presente Pagaré Electrónico presta **pleno mérito ejecutivo** de conformidad con los Artículos 244 y 422 del Código General del Proceso, la Ley 527 de 1999 y el Decreto 2364 de 2012. Serán de cargo del(de la) Deudor(a) las costas procesales, agencias en derecho y gastos comprobados de cobranza judicial o extrajudicial derivados del incumplimiento.`,
      ``,
      `---`,
      ``,
      `## IV. CARTA DE INSTRUCCIONES PARA EL DILIGENCIAMIENTO DEL PAGARÉ`,
      `*(Artículo 622 del Código de Comercio Colombiano)*`,
      ``,
      `De conformidad con lo dispuesto en el Artículo 622 del Código de Comercio, yo, **${debtorFullName}** (${debtorDocumentType} Nº ${debtorDocumentNumber}), autorizo de manera expresa, permanente e irrevocable a **${config.creditorLegalName}** (NIT ${config.creditorNit}), o a cualquier tenedor legítimo, para que sin previo aviso ni requerimiento judicial o extrajudicial diligencie los datos de liquidación definitivos del Pagaré Electrónico precedente, sujetándose estrictamente a las siguientes instrucciones:`,
      `1. **Fecha de Desembolso y Fecha de Vencimiento:** La fecha de inicio corresponderá al día y hora exacta del desembolso efectivo en la billetera CuyPay del(de la) Deudor(a); la fecha de vencimiento será el día en que se cumplan los **${termDays} días calendario** pactados, o la fecha en que se declare exigible la obligación por mora o aplicación de cláusula aceleratoria.`,
      `2. **Cuantía de Capital:** Corresponderá al monto de capital efectivamente desembolsado (**${formatCop(principalMinor)}**) menos los abonos a capital efectivamente recibidos y registrados en el libro mayor contable de CuyPay a la fecha de corte.`,
      `3. **Cuantía de Intereses:** Corresponderá a los intereses remuneratorios causados y no pagados a la tasa pactada (**${rateEaPercent.toFixed(2)}% E.A.**), más los intereses moratorios causados sobre el capital en mora liquidados sin superar el límite legal certificado por la Superintendencia Financiera de Colombia.`,
      `4. El título así integrado prestará mérito ejecutivo autónomo y reflejará fielmente los registros contables auditables de la operación.`,
      ``,
      `---`,
      ``,
      `## V. AUTORIZACIÓN DE HABEAS DATA FINANCIERO Y CENTRALES DE RIESGO`,
      `*(Ley 1266 de 2008, Ley 1581 de 2012 y Ley 2157 de 2021)*`,
      ``,
      `Autorizo de manera libre, previa, expresa e informada a **${config.creditorLegalName}** para consultar, solicitar, procesar, reportar, conservar y actualizar ante operadores de bancos de datos de información financiera, crediticia y comercial (incluyendo DataCrédito Experian, TransUnion CIFIN o quien haga sus veces) toda la información referente a mi comportamiento crediticio y cumplimiento de obligaciones dinerarias. En caso de mora, cualquier reporte negativo estará precedido de la comunicación previa al menos veinte (20) días calendario antes del reporte, enviada al correo electrónico (${debtorEmail}) o número móvil/WhatsApp (${debtorPhone}) aquí registrados, conforme al Artículo 12 de la Ley 1266 de 2008.`,
      ``,
      `---`,
      ``,
      `## VI. ACEPTACIÓN Y FIRMA ELECTRÓNICA CRIPTOGRÁFICA`,
      `*(Artículo 7 de la Ley 527 de 1999 y Decreto 2364 de 2012)*`,
      ``,
      `El(La) Deudor(a) manifiesta haber leído íntegramente el presente documento, comprender su alcance jurídico como **título valor ejecutivo**, y suscribirlo electrónicamente mediante autenticación biométrica (Face ID / Touch ID) vinculada a la llave privada criptográfica ECDSA P-256 custodiada en el hardware seguro (*Secure Enclave*) de su dispositivo registrado en CuyPay.`,
    ].join('\n');
  }

  async preview(user: User, input: LoanPreviewInput) {
    requireKycApproved(user);
    await assertNotFrozen(this.d, user.id);

    const config = await this.d.repos.loanConfig.get();
    if (!config.enabled) {
      throw new AppError('VALIDATION_ERROR', 'Las solicitudes de crédito se encuentran temporalmente pausadas');
    }

    const tier = config.rates.find((r) => r.termDays === input.termDays && r.enabled);
    if (!tier) {
      throw new AppError('VALIDATION_ERROR', `El plazo de ${input.termDays} días no está habilitado. Elige entre 30, 60, 90, 180 o 360 días.`);
    }

    if (input.principalMinor < config.minAmountMinor) {
      throw new AppError(
        'VALIDATION_ERROR',
        `El monto mínimo de crédito es de ${formatCop(config.minAmountMinor)}`,
        { minAmountMinor: config.minAmountMinor.toString() },
      );
    }
    if (input.principalMinor > config.maxAmountMinor) {
      throw new AppError(
        'VALIDATION_ERROR',
        `El monto máximo de crédito permitido es de ${formatCop(config.maxAmountMinor)}`,
        { maxAmountMinor: config.maxAmountMinor.toString() },
      );
    }

    const debtor = await this.resolveDebtorProfile(user, {
      documentType: input.documentType,
      documentNumber: input.documentNumber,
      city: input.city,
    });

    const nominalMonthlyPercent = computeNominalMonthlyPercent(tier.rateEaPercent);
    const interestMinor = computeCompoundInterestMinor(input.principalMinor, tier.rateEaPercent, input.termDays);
    const totalDueMinor = input.principalMinor + interestMinor;
    const now = this.d.clock.now();
    const estimatedDueAt = new Date(now.getTime() + input.termDays * 24 * 3600 * 1000);

    const documentMarkdown = this.buildLegalContractMarkdown({
      config,
      ...debtor,
      principalMinor: input.principalMinor,
      interestMinor,
      totalDueMinor,
      termDays: input.termDays,
      rateEaPercent: tier.rateEaPercent,
      nominalMonthlyPercent,
      moratoryRateEaPercent: config.moratoryRateEaPercent,
      purpose: input.purpose ?? null,
    });

    const documentSha256 = sha256Hex(Buffer.from(documentMarkdown, 'utf8'));

    return {
      principalMinor: input.principalMinor.toString(),
      interestMinor: interestMinor.toString(),
      totalDueMinor: totalDueMinor.toString(),
      termDays: input.termDays,
      interestRateEa: tier.rateEaPercent,
      nominalMonthlyPercent,
      moratoryRateEa: config.moratoryRateEaPercent,
      usuryCeilingEaPercent: config.usuryCeilingEaPercent,
      currency: 'COP' as const,
      estimatedDueAt: estimatedDueAt.toISOString(),
      debtor: {
        fullName: debtor.debtorFullName,
        documentType: debtor.debtorDocumentType,
        documentNumber: debtor.debtorDocumentNumber,
        email: debtor.debtorEmail,
        phone: debtor.debtorPhone,
        city: debtor.debtorCity,
      },
      creditor: {
        legalName: config.creditorLegalName,
        nit: config.creditorNit,
        domicile: config.creditorDomicile,
      },
      documentMarkdown,
      documentSha256,
    };
  }

  async apply(user: User, input: LoanApplyInput, sigCtx: LoanSignatureContext) {
    if (!input.acceptedPagare || !input.acceptedInstructionLetter || !input.acceptedCreditBureauAuth) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Debes aceptar expresamente el Pagaré a la Orden, la Carta de Instrucciones y la Autorización de Habeas Data para radicar tu crédito.',
      );
    }

    return this.mutex.run(user.id, async () => {
      const existingLoans = await this.d.repos.loans.listByUser(user.id);
      if (existingLoans.some((l) => l.status === 'overdue')) {
        throw new AppError(
          'CONFLICT',
          'Tienes una obligación vencida pendiente de pago. Ponla al día antes de solicitar un nuevo crédito.',
        );
      }
      if (existingLoans.some((l) => l.status === 'pending_review')) {
        throw new AppError(
          'CONFLICT',
          'Ya tienes una solicitud de crédito en estudio. Te notificaremos apenas sea revisada.',
        );
      }

      const quote = await this.preview(user, input);
      if (input.documentSha256 !== quote.documentSha256) {
        throw new AppError(
          'CONFLICT',
          'Las condiciones del documento cambiaron desde la previsualización. Revisa nuevamente el Pagaré antes de firmar.',
          { expectedSha256: quote.documentSha256 },
        );
      }

      const device = await this.d.repos.devices.byId(sigCtx.deviceId);
      if (!device || device.userId !== user.id || device.revokedAt) {
        throw new AppError('INVALID_SIGNATURE', 'Dispositivo firmante inválido');
      }

      const now = this.d.clock.now();
      const seq = await this.d.repos.promissoryNotes.nextSequence();
      const year = now.getUTCFullYear();
      const noteNumber = `PAG-${year}-${String(seq).padStart(6, '0')}`;
      const loanId = newId('loan', now);
      const noteId = newId('pag', now);

      const canonical = canonicalRequestString({
        method: sigCtx.method,
        path: sigCtx.path,
        rawBody: sigCtx.rawBody,
        timestamp: sigCtx.timestamp,
        nonce: sigCtx.nonce,
      });
      const canonicalSha256 = sha256Hex(Buffer.from(canonical, 'utf8'));

      const signatureEvidence: ElectronicSignatureEvidence = {
        method: 'ECDSA_P256_SHA256_SECURE_ENCLAVE',
        deviceId: device.id,
        deviceName: device.name,
        devicePublicKey: device.publicKey,
        ecdsaSignatureBase64: sigCtx.signature,
        canonicalSha256,
        nonce: sigCtx.nonce,
        timestampSec: Number(sigCtx.timestamp),
        signedAt: now.toISOString(),
        signerIp: sigCtx.ip,
        signerUserAgent: sigCtx.userAgent,
        acceptedPagare: true,
        acceptedInstructionLetter: true,
        acceptedCreditBureauAuth: true,
      };

      const config = await this.d.repos.loanConfig.get();
      const kycRec = await this.d.repos.kyc.byUser(user.id);
      const principalMinor = BigInt(quote.principalMinor);
      const interestMinor = BigInt(quote.interestMinor);
      const totalDueMinor = BigInt(quote.totalDueMinor);

      const note: PromissoryNote = {
        id: noteId,
        number: noteNumber,
        loanId,
        userId: user.id,
        status: 'signed_custody',
        principalMinor,
        interestMinor,
        totalDueMinor,
        termDays: quote.termDays,
        interestRateEa: quote.interestRateEa,
        nominalMonthlyPercent: quote.nominalMonthlyPercent,
        moratoryRateEa: quote.moratoryRateEa,
        currency: 'COP',
        creditorLegalName: config.creditorLegalName,
        creditorNit: config.creditorNit,
        creditorDomicile: config.creditorDomicile,
        debtorFullName: quote.debtor.fullName,
        debtorDocumentType: quote.debtor.documentType,
        debtorDocumentNumber: quote.debtor.documentNumber,
        debtorEmail: quote.debtor.email,
        debtorPhone: quote.debtor.phone,
        debtorCity: quote.debtor.city,
        sumsubApplicantId: kycRec?.applicantId ?? null,
        documentMarkdown: quote.documentMarkdown,
        documentSha256: quote.documentSha256,
        signature: signatureEvidence,
        disbursedAt: null,
        dueAt: null,
        cancelledAt: null,
        createdAt: now,
        updatedAt: now,
      };

      const loan: Loan = {
        id: loanId,
        userId: user.id,
        promissoryNoteId: noteId,
        promissoryNoteNumber: noteNumber,
        principalMinor,
        termDays: quote.termDays,
        interestRateEa: quote.interestRateEa,
        nominalMonthlyPercent: quote.nominalMonthlyPercent,
        moratoryRateEa: quote.moratoryRateEa,
        interestMinor,
        totalDueMinor,
        paidMinor: 0n,
        principalPaidMinor: 0n,
        interestPaidMinor: 0n,
        remainingMinor: totalDueMinor,
        currency: 'COP',
        status: 'pending_review',
        purpose: input.purpose?.trim() || null,
        debtorFullName: quote.debtor.fullName,
        debtorDocumentType: quote.debtor.documentType,
        debtorDocumentNumber: quote.debtor.documentNumber,
        debtorEmail: quote.debtor.email,
        debtorPhone: quote.debtor.phone,
        debtorCity: quote.debtor.city,
        requestedAt: now,
        approvedAt: null,
        approvedBy: null,
        disbursedAt: null,
        dueAt: null,
        paidAt: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectedReason: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.d.repos.promissoryNotes.create(note);
      await this.d.repos.loans.create(loan);

      this.d.logger.info(
        { userId: user.id, loanId, noteNumber, principalMinor: principalMinor.toString(), termDays: loan.termDays },
        'Solicitud de crédito y Pagaré electrónico firmados y radicados',
      );

      return this.presentLoan(loan);
    });
  }

  presentLoan(l: Loan) {
    const now = this.d.clock.now();
    const daysRemaining = l.dueAt
      ? Math.max(0, Math.ceil((l.dueAt.getTime() - now.getTime()) / (24 * 3600 * 1000)))
      : null;

    return {
      id: l.id,
      userId: l.userId,
      promissoryNoteId: l.promissoryNoteId,
      promissoryNoteNumber: l.promissoryNoteNumber,
      principalMinor: l.principalMinor.toString(),
      termDays: l.termDays,
      interestRateEa: l.interestRateEa,
      nominalMonthlyPercent: l.nominalMonthlyPercent,
      moratoryRateEa: l.moratoryRateEa,
      interestMinor: l.interestMinor.toString(),
      totalDueMinor: l.totalDueMinor.toString(),
      paidMinor: l.paidMinor.toString(),
      principalPaidMinor: l.principalPaidMinor.toString(),
      interestPaidMinor: l.interestPaidMinor.toString(),
      remainingMinor: l.remainingMinor.toString(),
      currency: l.currency,
      status: l.status,
      purpose: l.purpose,
      debtorFullName: l.debtorFullName,
      debtorDocumentType: l.debtorDocumentType,
      debtorDocumentNumber: l.debtorDocumentNumber,
      debtorEmail: l.debtorEmail,
      debtorPhone: l.debtorPhone,
      debtorCity: l.debtorCity,
      requestedAt: l.requestedAt.toISOString(),
      approvedAt: l.approvedAt?.toISOString() ?? null,
      approvedBy: l.approvedBy,
      disbursedAt: l.disbursedAt?.toISOString() ?? null,
      dueAt: l.dueAt?.toISOString() ?? null,
      paidAt: l.paidAt?.toISOString() ?? null,
      rejectedAt: l.rejectedAt?.toISOString() ?? null,
      rejectedReason: l.rejectedReason,
      daysRemaining,
    };
  }

  presentPromissoryNote(note: PromissoryNote, loan: Loan | null) {
    const integrityVerified = sha256Hex(Buffer.from(note.documentMarkdown, 'utf8')) === note.documentSha256;
    return {
      id: note.id,
      number: note.number,
      loanId: note.loanId,
      userId: note.userId,
      status: note.status,
      integrityVerified,
      principalMinor: note.principalMinor.toString(),
      interestMinor: note.interestMinor.toString(),
      totalDueMinor: note.totalDueMinor.toString(),
      paidMinor: (loan?.paidMinor ?? 0n).toString(),
      remainingMinor: (loan?.remainingMinor ?? note.totalDueMinor).toString(),
      termDays: note.termDays,
      interestRateEa: note.interestRateEa,
      nominalMonthlyPercent: note.nominalMonthlyPercent,
      moratoryRateEa: note.moratoryRateEa,
      currency: note.currency,
      creditorLegalName: note.creditorLegalName,
      creditorNit: note.creditorNit,
      creditorDomicile: note.creditorDomicile,
      debtorFullName: note.debtorFullName,
      debtorDocumentType: note.debtorDocumentType,
      debtorDocumentNumber: note.debtorDocumentNumber,
      debtorEmail: note.debtorEmail,
      debtorPhone: note.debtorPhone,
      debtorCity: note.debtorCity,
      sumsubApplicantId: note.sumsubApplicantId,
      documentMarkdown: note.documentMarkdown,
      documentSha256: note.documentSha256,
      signature: note.signature,
      disbursedAt: note.disbursedAt?.toISOString() ?? null,
      dueAt: note.dueAt?.toISOString() ?? null,
      cancelledAt: note.cancelledAt?.toISOString() ?? null,
      createdAt: note.createdAt.toISOString(),
      printableHtml: this.renderPrintableHtml(note, loan, integrityVerified),
    };
  }

  private renderPrintableHtml(note: PromissoryNote, loan: Loan | null, integrityVerified: boolean): string {
    const remaining = loan ? loan.remainingMinor : note.totalDueMinor;
    const paid = loan ? loan.paidMinor : 0n;
    const statusLabel =
      note.status === 'active_enforceable'
        ? 'VIGENTE CON MÉRITO EJECUTIVO (DESEMBOLSADO)'
        : note.status === 'cancelled_paid'
          ? 'CANCELADO POR PAGO TOTAL — PAZ Y SALVO'
          : note.status === 'voided_rejected'
            ? 'ANULADO SIN DESEMBOLSO (SOLICITUD NO APROBADA)'
            : 'FIRMADO EN CUSTODIA (PENDIENTE DE APROBACIÓN Y DESEMBOLSO)';

    const bodyParagraphs = escapeHtml(note.documentMarkdown)
      .split('\n')
      .map((line) => {
        if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
        if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
        if (line === '---') return `<hr />`;
        if (line.startsWith('- ')) return `<li>${line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`;
        if (!line.trim()) return `<div style="height:8px"></div>`;
        return `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')}</p>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="es-CO">
<head>
  <meta charset="utf-8" />
  <title>Pagaré Electrónico ${escapeHtml(note.number)} — ${escapeHtml(note.debtorFullName)}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; color: #111; max-width: 820px; margin: 28px auto; padding: 0 24px; line-height: 1.55; font-size: 13.5px; }
    h1 { font-size: 18px; text-transform: uppercase; border-bottom: 2px solid #0B3B35; padding-bottom: 8px; color: #0B3B35; }
    h2 { font-size: 14.5px; color: #0B3B35; margin-top: 20px; margin-bottom: 8px; }
    p, li { margin: 4px 0; text-align: justify; }
    hr { border: none; border-top: 1px solid #d4d4d4; margin: 16px 0; }
    .banner { border: 1.5px solid #0B3B35; background: #f4f9f8; padding: 12px 16px; border-radius: 8px; margin-bottom: 18px; font-family: system-ui, sans-serif; font-size: 12.5px; }
    .box { border: 1px solid #bbb; padding: 14px 16px; border-radius: 8px; margin-top: 20px; background: #fafafa; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0; font-family: system-ui, sans-serif; font-size: 12.5px; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; }
    th { background: #f0f4f3; }
    @media print { body { margin: 10px; } }
  </style>
</head>
<body>
  <div class="banner">
    <strong>PAGARÉ ELECTRÓNICO A LA ORDEN Nº ${escapeHtml(note.number)}</strong><br/>
    Estado jurídico del título: <strong>${statusLabel}</strong><br/>
    Integridad criptográfica SHA-256: <strong>${integrityVerified ? 'VERIFICADA INTACTA' : 'ALERTA DE INTEGRIDAD'}</strong>
  </div>

  ${bodyParagraphs}

  <h2>VII. CUADRO DE DILIGENCIAMIENTO Y ESTADO DE LIQUIDACIÓN (CARTA DE INSTRUCCIONES — ART. 622 C.CO.)</h2>
  <table>
    <tr><th>Número Único del Título</th><td>${escapeHtml(note.number)} (ID: ${escapeHtml(note.id)})</td></tr>
    <tr><th>Fecha y Hora de Desembolso Efectivo</th><td>${note.disbursedAt ? escapeHtml(note.disbursedAt.toISOString()) : 'Pendiente de desembolso'}</td></tr>
    <tr><th>Fecha y Hora Exacta de Vencimiento</th><td>${note.dueAt ? escapeHtml(note.dueAt.toISOString()) : 'Se fija automáticamente al desembolsar'}</td></tr>
    <tr><th>Capital Desembolsado</th><td>${escapeHtml(formatCop(note.principalMinor))}</td></tr>
    <tr><th>Intereses Remuneratorios Pactados (${note.interestRateEa.toFixed(2)}% E.A.)</th><td>${escapeHtml(formatCop(note.interestMinor))}</td></tr>
    <tr><th>Total Obligación Inicial</th><td>${escapeHtml(formatCop(note.totalDueMinor))}</td></tr>
    <tr><th>Abonos Registrados a la Fecha</th><td>${escapeHtml(formatCop(paid))}</td></tr>
    <tr><th>Saldo Insoluto Exigible a la Fecha</th><td><strong>${escapeHtml(formatCop(remaining))}</strong></td></tr>
  </table>

  <div class="box">
    <strong>CERTIFICADO PROBATORIO DE FIRMA ELECTRÓNICA (LEY 527 DE 1999 Y DECRETO 2364 DE 2012)</strong><br/><br/>
    • Método Criptográfico: ${escapeHtml(note.signature.method)}<br/>
    • Firmante Verificado: ${escapeHtml(note.debtorFullName)} (${escapeHtml(note.debtorDocumentType)} ${escapeHtml(note.debtorDocumentNumber)})<br/>
    • Expediente Biométrico Sumsub KYC: ${escapeHtml(note.sumsubApplicantId ?? 'Verificado en plataforma')}<br/>
    • Fecha y Hora Exacta de Firma (UTC): ${escapeHtml(note.signature.signedAt)} (Epoch: ${note.signature.timestampSec})<br/>
    • Dispositivo Enrolado: ${escapeHtml(note.signature.deviceName)} (ID: ${escapeHtml(note.signature.deviceId)})<br/>
    • Clave Pública P-256 del Dispositivo (X9.63 Base64): ${escapeHtml(note.signature.devicePublicKey)}<br/>
    • Hash SHA-256 del Documento Íntegro: ${escapeHtml(note.documentSha256)}<br/>
    • Hash SHA-256 de Cadena Canónica Firmada: ${escapeHtml(note.signature.canonicalSha256)}<br/>
    • Firma Digital ECDSA-SHA256 (DER Base64): ${escapeHtml(note.signature.ecdsaSignatureBase64)}<br/>
    • Nonce Anti-Replay: ${escapeHtml(note.signature.nonce)}<br/>
    • Dirección IP / Agente de Usuario: ${escapeHtml(note.signature.signerIp)} · ${escapeHtml(note.signature.signerUserAgent)}
  </div>
</body>
</html>`;
  }

  async listUserLoans(userId: string) {
    await this.syncOverdueLoans();
    const loans = await this.d.repos.loans.listByUser(userId);
    let activeRemainingMinor = 0n;
    let activeCount = 0;
    let pendingCount = 0;

    for (const l of loans) {
      if (l.status === 'approved_active' || l.status === 'overdue') {
        activeRemainingMinor += l.remainingMinor;
        activeCount++;
      } else if (l.status === 'pending_review') {
        pendingCount++;
      }
    }

    return {
      loans: loans.map((l) => this.presentLoan(l)),
      summary: {
        activeRemainingMinor: activeRemainingMinor.toString(),
        activeCount,
        pendingCount,
      },
    };
  }

  async getUserPromissoryNote(userId: string, loanId: string) {
    const loan = await this.d.repos.loans.byId(loanId);
    if (!loan || loan.userId !== userId) throw new AppError('NOT_FOUND', 'Crédito no encontrado');
    const note = await this.d.repos.promissoryNotes.byLoanId(loan.id);
    if (!note) throw new AppError('NOT_FOUND', 'Pagaré electrónico no encontrado');
    return this.presentPromissoryNote(note, loan);
  }

  /** El cliente realiza un abono parcial o pago total de su crédito desde su billetera COP. */
  async payLoan(user: User, loanId: string, amountMinor: bigint) {
    if (amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'El monto a pagar debe ser mayor a cero');
    }
    return this.mutex.run(user.id, async () => {
      const loan = await this.d.repos.loans.byId(loanId);
      if (!loan || loan.userId !== user.id) throw new AppError('NOT_FOUND', 'Crédito no encontrado');
      if (loan.status !== 'approved_active' && loan.status !== 'overdue') {
        throw new AppError('CONFLICT', 'Este crédito no se encuentra activo para recibir pagos');
      }

      const payMinor = amountMinor > loan.remainingMinor ? loan.remainingMinor : amountMinor;
      const wallet = await this.ledger.wallet(user.id, 'COP');
      if (wallet.availableMinor < payMinor) {
        throw new AppError(
          'INSUFFICIENT_FUNDS',
          `Saldo insuficiente en tu billetera COP (${formatCop(wallet.availableMinor)} disponibles).`,
          { availableMinor: wallet.availableMinor.toString(), requiredMinor: payMinor.toString() },
        );
      }

      // Art. 1653 Código Civil: primero intereses pendientes, luego capital
      const interestRemaining = loan.interestMinor - loan.interestPaidMinor;
      const interestLeg = payMinor <= interestRemaining ? payMinor : interestRemaining;
      const principalLeg = payMinor - interestLeg;

      const now = this.d.clock.now();
      const txId = newId('txn', now);

      const legs: Leg[] = [{ kind: 'user_available', userId: user.id, currency: 'COP', amountMinor: -payMinor }];
      if (principalLeg > 0n) {
        // El capital pagado regresa directamente al Bolsillo de Préstamos para seguir prestando
        legs.push({ kind: 'loan_pool', userId: null, currency: 'COP', amountMinor: principalLeg });
      }
      if (interestLeg > 0n) {
        legs.push({ kind: 'fee_revenue', userId: null, currency: 'COP', amountMinor: interestLeg });
      }

      await this.ledger.post(legs, txId);

      loan.paidMinor += payMinor;
      loan.interestPaidMinor += interestLeg;
      loan.principalPaidMinor += principalLeg;
      loan.remainingMinor = loan.totalDueMinor - loan.paidMinor;
      loan.updatedAt = now;

      const isFullyPaid = loan.remainingMinor === 0n;
      if (isFullyPaid) {
        loan.status = 'paid';
        loan.paidAt = now;
        const note = await this.d.repos.promissoryNotes.byLoanId(loan.id);
        if (note) {
          note.status = 'cancelled_paid';
          note.cancelledAt = now;
          note.updatedAt = now;
          await this.d.repos.promissoryNotes.update(note);
        }
      }

      await this.d.repos.loans.update(loan);

      const txn: Transaction = {
        id: txId,
        userId: user.id,
        type: 'loan',
        direction: 'out',
        currency: 'COP',
        amountMinor: payMinor,
        feeMinor: 0n,
        status: 'completed',
        title: isFullyPaid ? 'Pago Total de Crédito CuyPay' : 'Abono a Crédito CuyPay',
        subtitle: `Pagaré ${loan.promissoryNoteNumber}`,
        description: isFullyPaid
          ? `Crédito liquidado en su totalidad. Paz y salvo generado sobre ${loan.promissoryNoteNumber}.`
          : `Abono aplicado. Saldo restante: ${formatCop(loan.remainingMinor)}.`,
        conversion: null,
        beneficiaryId: null,
        quoteId: null,
        providerRef: loan.id,
        flagged: false,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.transactions.create(txn);
      await this.d.events.publish({ type: 'transaction.created', txn });

      return {
        loan: this.presentLoan(loan),
        paidAmountMinor: payMinor.toString(),
        pazYSalvoIssued: isFullyPaid,
      };
    });
  }

  // ───────────── Operaciones Admin (Bolsillo de Préstamos + Aprobación + Cartera) ─────────────

  async getPoolSummary() {
    await this.syncOverdueLoans();
    const [availablePoolMinor, allLoans] = await Promise.all([
      this.ledger.systemPoolBalance('loan_pool', 'COP'),
      this.d.repos.loans.listAll(),
    ]);

    let activePortfolioPrincipalMinor = 0n;
    let activePortfolioRemainingMinor = 0n;
    let pendingExpectedInterestMinor = 0n;
    let collectedInterestMinor = 0n;
    let pendingApplicationsPrincipalMinor = 0n;
    let overdueRemainingMinor = 0n;
    let pendingApplicationsCount = 0;
    let activeLoansCount = 0;
    let overdueLoansCount = 0;
    let paidLoansCount = 0;

    for (const l of allLoans) {
      collectedInterestMinor += l.interestPaidMinor;
      if (l.status === 'pending_review') {
        pendingApplicationsCount++;
        pendingApplicationsPrincipalMinor += l.principalMinor;
      } else if (l.status === 'approved_active') {
        activeLoansCount++;
        activePortfolioPrincipalMinor += l.principalMinor - l.principalPaidMinor;
        activePortfolioRemainingMinor += l.remainingMinor;
        pendingExpectedInterestMinor += l.interestMinor - l.interestPaidMinor;
      } else if (l.status === 'overdue') {
        overdueLoansCount++;
        activePortfolioPrincipalMinor += l.principalMinor - l.principalPaidMinor;
        activePortfolioRemainingMinor += l.remainingMinor;
        overdueRemainingMinor += l.remainingMinor;
        pendingExpectedInterestMinor += l.interestMinor - l.interestPaidMinor;
      } else if (l.status === 'paid') {
        paidLoansCount++;
      }
    }

    return {
      currency: 'COP' as const,
      availablePoolMinor: availablePoolMinor.toString(),
      activePortfolioPrincipalMinor: activePortfolioPrincipalMinor.toString(),
      activePortfolioRemainingMinor: activePortfolioRemainingMinor.toString(),
      pendingExpectedInterestMinor: pendingExpectedInterestMinor.toString(),
      collectedInterestMinor: collectedInterestMinor.toString(),
      pendingApplicationsPrincipalMinor: pendingApplicationsPrincipalMinor.toString(),
      overdueRemainingMinor: overdueRemainingMinor.toString(),
      pendingApplicationsCount,
      activeLoansCount,
      overdueLoansCount,
      paidLoansCount,
    };
  }

  async fundPool(ctx: AdminContext | null, amountMinor: bigint, reason: string) {
    if (amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'El monto para fondear el Bolsillo de Préstamos debe ser mayor a cero');
    }
    await this.ledger.post(
      [
        { kind: 'treasury_capital', userId: null, currency: 'COP', amountMinor: -amountMinor },
        { kind: 'loan_pool', userId: null, currency: 'COP', amountMinor: amountMinor },
      ],
      null,
    );
    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'loans.pool_fund',
        targetType: 'loan_pool',
        targetId: 'COP',
        reason,
        after: { amountMinor: amountMinor.toString() },
      });
    }
    return this.getPoolSummary();
  }

  async withdrawPool(ctx: AdminContext | null, amountMinor: bigint, reason: string) {
    if (amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'El monto a retirar debe ser mayor a cero');
    }
    const available = await this.ledger.systemPoolBalance('loan_pool', 'COP');
    if (available < amountMinor) {
      throw new AppError(
        'INSUFFICIENT_FUNDS',
        `Saldo insuficiente en el Bolsillo de Préstamos (${formatCop(available)} disponibles).`,
        { availableMinor: available.toString(), requestedMinor: amountMinor.toString() },
      );
    }
    await this.ledger.post(
      [
        { kind: 'loan_pool', userId: null, currency: 'COP', amountMinor: -amountMinor },
        { kind: 'treasury_capital', userId: null, currency: 'COP', amountMinor: amountMinor },
      ],
      null,
    );
    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'loans.pool_withdraw',
        targetType: 'loan_pool',
        targetId: 'COP',
        reason,
        after: { amountMinor: amountMinor.toString() },
      });
    }
    return this.getPoolSummary();
  }

  async listAdminLoans(statusFilter?: string) {
    await this.syncOverdueLoans();
    const all = await this.d.repos.loans.listAll();
    const filtered = statusFilter ? all.filter((l) => l.status === statusFilter) : all;
    return {
      items: filtered.map((l) => this.presentLoan(l)),
    };
  }

  async getAdminPromissoryNote(loanId: string) {
    const loan = await this.d.repos.loans.byId(loanId);
    if (!loan) throw new AppError('NOT_FOUND', 'Solicitud de crédito no encontrada');
    const note = await this.d.repos.promissoryNotes.byLoanId(loan.id);
    if (!note) throw new AppError('NOT_FOUND', 'Pagaré electrónico no encontrado');
    return this.presentPromissoryNote(note, loan);
  }

  /**
   * Aprueba la solicitud de crédito: debita automáticamente el Bolsillo de Préstamos (`loan_pool`),
   * acredita la billetera COP del cliente (`user_available`), activa el mérito ejecutivo del Pagaré
   * y envía la notificación inmediata de dinero recibido.
   */
  async approveLoan(ctx: AdminContext | null, loanId: string, reason: string) {
    const first = await this.d.repos.loans.byId(loanId);
    if (!first) throw new AppError('NOT_FOUND', 'Solicitud de crédito no encontrada');

    return this.mutex.run(first.userId, async () => {
      const loan = await this.d.repos.loans.byId(loanId);
      if (!loan) throw new AppError('NOT_FOUND', 'Solicitud de crédito no encontrada');
      if (loan.status !== 'pending_review') {
        throw new AppError('CONFLICT', `La solicitud ya fue procesada (estado actual: ${loan.status})`);
      }

      await assertNotFrozen(this.d, loan.userId);

      const availablePool = await this.ledger.systemPoolBalance('loan_pool', 'COP');
      if (availablePool < loan.principalMinor) {
        throw new AppError(
          'INSUFFICIENT_FUNDS',
          `Saldo insuficiente en el Bolsillo de Préstamos (${formatCop(availablePool)} disponibles para desembolsar ${formatCop(loan.principalMinor)}). Fondea primero el Bolsillo de Préstamos.`,
          { availablePoolMinor: availablePool.toString(), requiredMinor: loan.principalMinor.toString() },
        );
      }

      const now = this.d.clock.now();
      const dueAt = new Date(now.getTime() + loan.termDays * 24 * 3600 * 1000);
      const txId = newId('txn', now);

      // Desembolso automático: debita loan_pool y acredita user_available del cliente
      await this.ledger.post(
        [
          { kind: 'loan_pool', userId: null, currency: 'COP', amountMinor: -loan.principalMinor },
          { kind: 'user_available', userId: loan.userId, currency: 'COP', amountMinor: loan.principalMinor },
        ],
        txId,
      );

      loan.status = 'approved_active';
      loan.approvedAt = now;
      loan.approvedBy = ctx?.admin.email ?? 'admin@cuypay.com';
      loan.disbursedAt = now;
      loan.dueAt = dueAt;
      loan.updatedAt = now;
      await this.d.repos.loans.update(loan);

      const note = await this.d.repos.promissoryNotes.byLoanId(loan.id);
      if (note) {
        note.status = 'active_enforceable';
        note.disbursedAt = now;
        note.dueAt = dueAt;
        note.updatedAt = now;
        await this.d.repos.promissoryNotes.update(note);
      }

      const txn: Transaction = {
        id: txId,
        userId: loan.userId,
        type: 'deposit',
        direction: 'in',
        currency: 'COP',
        amountMinor: loan.principalMinor,
        feeMinor: 0n,
        status: 'completed',
        title: 'Desembolso Crédito CuyPay',
        subtitle: `Pagaré ${loan.promissoryNoteNumber} · ${loan.termDays} días`,
        description: `Desembolso aprobado en tu cuenta. Vencimiento: ${dueAt.toISOString()}`,
        conversion: null,
        beneficiaryId: null,
        quoteId: null,
        providerRef: loan.id,
        flagged: false,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.transactions.create(txn);
      await this.d.events.publish({ type: 'transaction.created', txn });

      if (ctx && this.audit) {
        await this.audit.record(ctx, {
          action: 'loans.approve',
          targetType: 'loan',
          targetId: loan.id,
          reason,
          after: {
            promissoryNoteNumber: loan.promissoryNoteNumber,
            principalMinor: loan.principalMinor.toString(),
            totalDueMinor: loan.totalDueMinor.toString(),
            termDays: loan.termDays,
            dueAt: dueAt.toISOString(),
          },
        });
      }

      this.d.logger.info(
        { loanId: loan.id, userId: loan.userId, principalMinor: loan.principalMinor.toString(), noteNumber: loan.promissoryNoteNumber },
        'Crédito aprobado y desembolsado desde Bolsillo de Préstamos',
      );

      return {
        loan: this.presentLoan(loan),
        pool: await this.getPoolSummary(),
      };
    });
  }

  async rejectLoan(ctx: AdminContext | null, loanId: string, reason: string) {
    const loan = await this.d.repos.loans.byId(loanId);
    if (!loan) throw new AppError('NOT_FOUND', 'Solicitud de crédito no encontrada');
    if (loan.status !== 'pending_review') {
      throw new AppError('CONFLICT', `Solo se pueden rechazar solicitudes en revisión (estado actual: ${loan.status})`);
    }

    const now = this.d.clock.now();
    loan.status = 'rejected';
    loan.rejectedAt = now;
    loan.rejectedBy = ctx?.admin.email ?? 'admin@cuypay.com';
    loan.rejectedReason = reason;
    loan.remainingMinor = 0n;
    loan.updatedAt = now;
    await this.d.repos.loans.update(loan);

    const note = await this.d.repos.promissoryNotes.byLoanId(loan.id);
    if (note) {
      note.status = 'voided_rejected';
      note.cancelledAt = now;
      note.updatedAt = now;
      await this.d.repos.promissoryNotes.update(note);
    }

    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'loans.reject',
        targetType: 'loan',
        targetId: loan.id,
        reason,
        after: { status: 'rejected', promissoryNoteNumber: loan.promissoryNoteNumber },
      });
    }

    return {
      loan: this.presentLoan(loan),
      pool: await this.getPoolSummary(),
    };
  }

  /** Marca como `overdue` los préstamos activos cuya fecha/hora exacta de vencimiento haya expirado. */
  async syncOverdueLoans(): Promise<number> {
    const now = this.d.clock.now();
    const all = await this.d.repos.loans.listAll();
    let marked = 0;
    for (const l of all) {
      if (l.status === 'approved_active' && l.dueAt && now.getTime() > l.dueAt.getTime() && l.remainingMinor > 0n) {
        l.status = 'overdue';
        l.updatedAt = now;
        await this.d.repos.loans.update(l);
        marked++;
      }
    }
    return marked;
  }
}
