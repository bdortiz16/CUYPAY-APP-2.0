import Image from "next/image";
import { Calculator } from "@/components/landing/Calculator";
import { SiteFooter, SiteHeader, TESTFLIGHT_URL } from "@/components/site/SiteChrome";
import { Isotype } from "@/components/site/Logo";
import s from "./landing.module.css";

const FAQ: { q: string; a: string }[] = [
  {
    q: "¿Qué es Bre-B y por qué tengo mi propia llave?",
    a: "Bre-B es el sistema de pagos inmediatos del Banco de la República. Con CuyPay creas una llave propia (por ejemplo @cuypayana123) y cualquier persona con cuenta en un banco o billetera en Colombia te puede enviar pesos al instante, a cualquier hora.",
  },
  {
    q: "¿Cuánto cuesta convertir de pesos a reales?",
    a: "Una comisión del 1 % sobre el monto (mínimo $ 2.000) más el margen de la tasa, que ves completo antes de confirmar. No hay cuotas de manejo ni cobros por recibir pesos.",
  },
  {
    q: "¿Cuánto dura la cotización?",
    a: "30 segundos. Durante ese tiempo la tasa queda fija; si se vence, la app te muestra una nueva antes de que confirmes con Face ID.",
  },
  {
    q: "¿Qué necesito para abrir mi cuenta?",
    a: "Un iPhone, tu número celular colombiano y tu cédula. Verificamos tu identidad con Sumsub en unos minutos (foto del documento y una selfie en video).",
  },
  {
    q: "¿Hay límites?",
    a: "Sí. Hay límites diarios, mensuales y anuales para enviar, convertir y recibir, que dependen de tu nivel de verificación. Siempre ves en la app cuánto llevas usado y cuánto te queda.",
  },
  {
    q: "¿Mis datos biométricos salen de mi celular?",
    a: "No. Face ID funciona dentro de tu iPhone: CuyPay nunca recibe tu rostro ni tu huella. La app solo recibe una firma criptográfica generada en el Secure Enclave cuando apruebas una operación.",
  },
  {
    q: "¿Puedo usar CuyPay en Android?",
    a: "Por ahora CuyPay es solo para iPhone. Estamos en beta privada por TestFlight y la versión en App Store llega pronto.",
  },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "CuyPay",
      legalName: "XATECH SERVICES S.A.S.",
      url: "https://www.cuypay.com",
      logo: "https://www.cuypay.com/brand/cuypay-isotipo-spruce.png",
      email: "info@cuypay.com",
      areaServed: ["CO", "BR"],
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ],
};

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* HERO */}
        <section className={s.hero} aria-labelledby="hero-title">
          <div className={s.heroGlow} aria-hidden />
          <div className={`container ${s.heroGrid}`}>
            <div className={s.heroCopy}>
              <p className={s.eyebrow}>
                <span aria-hidden>🇨🇴</span> Colombia <span className={s.eyebrowArrow} aria-hidden>→</span> Brasil <span aria-hidden>🇧🇷</span>
              </p>
              <h1 id="hero-title" className={s.heroTitle}>
                Tus pesos, <span className={s.mark}>en reales</span>. Sin vueltas.
              </h1>
              <p className={s.heroLead}>
                Recibe COP con tu propia llave Bre-B, conviértelos a BRL viendo la comisión antes de confirmar y envía por Bre-B
                cuando lo necesites. Todo desde tu iPhone, protegido con Face ID.
              </p>
              <div className={s.heroCtas}>
                <a href="#descargar" className="btn" id="hero-descargar">
                  Descargar la beta
                </a>
                <a href="#como-funciona" className="btn btn-ghost-dark" id="hero-como-funciona">
                  Ver cómo funciona
                </a>
              </div>
              <ul className={s.heroFacts}>
                <li>
                  <strong>24/7</strong>
                  <span>recibes por Bre-B</span>
                </li>
                <li>
                  <strong>30 s</strong>
                  <span>cotización fija</span>
                </li>
                <li>
                  <strong>1 %</strong>
                  <span>comisión visible</span>
                </li>
              </ul>
            </div>
            <div className={s.heroCalc}>
              <Calculator />
            </div>
          </div>
        </section>

        {/* CÓMO FUNCIONA */}
        <section id="como-funciona" className={s.how} aria-labelledby="how-title">
          <div className="container">
            <header className={s.sectionHead}>
              <p className={s.kicker}>Cómo funciona</p>
              <h2 id="how-title" className={s.h2}>
                Bre-B para recibir. CuyPay para el resto.
              </h2>
              <p className={s.sectionLead}>
                Bre-B conecta a todos los bancos y billeteras de Colombia con pagos inmediatos. CuyPay te da una llave propia y
                se encarga de llevar tus pesos a reales.
              </p>
            </header>

            <ol className={s.steps}>
              <li className={s.step}>
                <span className={s.stepNum}>01</span>
                <h3>Recibe con tu llave</h3>
                <p>Crea tu llave Bre-B en la app y compártela. Te envían desde Bancolombia, Nequi, Davivienda o cualquier entidad, al instante.</p>
                <div className={s.miniCard} aria-hidden>
                  <span className={s.miniLabel}>Tu llave Bre-B</span>
                  <span className={s.alias}>@cuypayana123</span>
                  <span className={s.miniRow}>
                    <span>Recibido · Laura Ríos</span>
                    <span className={s.pos}>+$ 350.000</span>
                  </span>
                </div>
              </li>
              <li className={s.step}>
                <span className={s.stepNum}>02</span>
                <h3>Convierte a reales</h3>
                <p>Pides la cotización, ves la tasa, la comisión y lo que recibes. Si te sirve, confirmas con Face ID.</p>
                <div className={s.miniCard} aria-hidden>
                  <span className={s.miniLabel}>Cotización · 30 s</span>
                  <span className={s.miniRow}>
                    <span>$ 500.000</span>
                    <span className={s.arrow}>→</span>
                    <span className={s.brl}>R$ 643,63</span>
                  </span>
                  <span className={s.miniBar}>
                    <span style={{ width: "62%" }} />
                  </span>
                </div>
              </li>
              <li className={s.step}>
                <span className={s.stepNum}>03</span>
                <h3>Envía por Bre-B</h3>
                <p>Inscribe beneficiarios: verificamos el titular de la llave antes del primer envío. Luego envías en segundos.</p>
                <div className={s.miniCard} aria-hidden>
                  <span className={s.miniLabel}>Beneficiario verificado</span>
                  <span className={s.miniRow}>
                    <span className={s.avatar}>JP</span>
                    <span className={s.miniName}>
                      Juan Pérez
                      <small>Bancolombia · 300 123 4567</small>
                    </span>
                    <span className={s.check}>✓</span>
                  </span>
                </div>
              </li>
            </ol>
          </div>
        </section>

        {/* BOLSILLOS */}
        <section id="bolsillos" className={s.pockets} aria-labelledby="pockets-title">
          <div className={`container ${s.pocketsGrid}`}>
            <div className={s.phoneWrap}>
              <Image
                src="/img/app-cuypay-iphone.jpg"
                alt="Pantalla principal de CuyPay en un iPhone con el saldo en pesos, la tasa COP a BRL y los últimos movimientos"
                width={896}
                height={1200}
                className={s.phone}
                sizes="(max-width: 860px) 80vw, 460px"
              />
            </div>
            <div className={s.pocketsCopy}>
              <p className={`${s.kicker} ${s.kickerDark}`}>Dos bolsillos</p>
              <h2 id="pockets-title" className={`${s.h2} ${s.h2Dark}`}>
                Pesos de un lado, reales del otro.
              </h2>
              <p className={s.sectionLeadDark}>
                Cada moneda vive en su propio bolsillo, con su saldo disponible y lo retenido. Pasas de uno a otro cuando la tasa
                te conviene.
              </p>
              <div className={s.pocketCards}>
                <article className={s.pocket}>
                  <header>
                    <span className={s.pocketFlag} aria-hidden>🇨🇴</span>
                    <span>Bolsillo COP</span>
                  </header>
                  <p className={`${s.pocketAmount} num`}>$ 1.250.000</p>
                  <p className={s.pocketNote}>Recibes por Bre-B y envías a beneficiarios verificados.</p>
                </article>
                <article className={s.pocket}>
                  <header>
                    <span className={s.pocketFlag} aria-hidden>🇧🇷</span>
                    <span>Bolsillo BRL</span>
                  </header>
                  <p className={`${s.pocketAmount} num`}>R$ 1.823,00</p>
                  <p className={s.pocketNote}>Tus reales, listos. Cada conversión aparece una sola vez en tu historial.</p>
                </article>
              </div>
              <ul className={s.ticks}>
                <li>Gráfica de la tasa COP → BRL de los últimos 30 días.</li>
                <li>Movimientos con fecha, contraparte y comisión, sin letra pequeña.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* SEGURIDAD */}
        <section id="seguridad" className={s.security} aria-labelledby="security-title">
          <div className={`container ${s.securityGrid}`}>
            <div>
              <p className={s.kicker}>Seguridad</p>
              <h2 id="security-title" className={s.h2}>
                Cada operación la apruebas tú, con tu cara.
              </h2>
              <p className={s.sectionLead}>
                Diseñamos CuyPay para que nadie más pueda mover tu dinero, ni siquiera con tu celular desbloqueado.
              </p>
              <dl className={s.secList}>
                <div>
                  <dt>Face ID y Secure Enclave</dt>
                  <dd>
                    Tu llave de firma vive en el chip seguro del iPhone. Enviar, convertir o crear tu llave Bre-B exige Face ID
                    cada vez. Tus datos biométricos nunca salen del teléfono.
                  </dd>
                </div>
                <div>
                  <dt>Verificación de identidad con Sumsub</dt>
                  <dd>Validamos tu cédula y una selfie en video antes de que puedas mover dinero.</dd>
                </div>
                <div>
                  <dt>Revisión AML de beneficiarios</dt>
                  <dd>
                    Antes de tu primer envío a alguien, revisamos al titular de la llave contra listas restrictivas (ONU, OFAC,
                    PEP) según nuestro sistema SARLAFT.
                  </dd>
                </div>
                <div>
                  <dt>Límites claros</dt>
                  <dd>Topes diarios, mensuales y anuales por operación, en hora de Bogotá. Siempre sabes cuánto te queda.</dd>
                </div>
              </dl>
            </div>
            <aside className={s.limitsCard} aria-label="Ejemplo de límites en la app">
              <div className={s.limitsHead}>
                <Isotype size={22} color="#197168" />
                <span>Tus límites · Nivel completo</span>
              </div>
              {[
                { label: "Envíos hoy", used: 50_000, total: 3_000_000 },
                { label: "Conversiones hoy", used: 1_200_000, total: 2_000_000 },
                { label: "Envíos este mes", used: 4_350_000, total: 20_000_000 },
                { label: "Recibido este mes", used: 9_800_000, total: 20_000_000 },
              ].map((l) => {
                const pct = Math.round((l.used / l.total) * 100);
                return (
                  <div key={l.label} className={s.limitRow}>
                    <div className={s.limitTop}>
                      <span>{l.label}</span>
                      <span className="num">
                        $ {l.used.toLocaleString("es-CO")} <small>/ $ {l.total.toLocaleString("es-CO")}</small>
                      </span>
                    </div>
                    <div
                      className={s.limitBar}
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={l.label}
                    >
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              <p className={s.faceId}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                  <path
                    d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1.5M15 9v1.5M12 9v4h-1M9 16c1.6 1.2 4.4 1.2 6 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Confirma con Face ID para enviar
              </p>
            </aside>
          </div>
        </section>

        {/* DESCARGAR */}
        <section id="descargar" className={s.download} aria-labelledby="download-title">
          <div className={s.downloadGlow} aria-hidden />
          <div className={`container ${s.downloadInner}`}>
            <Isotype size={56} color="#fff" />
            <h2 id="download-title" className={`${s.h2} ${s.h2Dark} ${s.center}`}>
              Pruébala antes que nadie.
            </h2>
            <p className={`${s.sectionLeadDark} ${s.center}`}>
              CuyPay está en beta privada para iPhone. Únete por TestFlight y ayúdanos a pulir la app antes del lanzamiento en
              App Store.
            </p>
            <div className={s.stores}>
              <a href={TESTFLIGHT_URL} className="btn btn-light" id="download-testflight" rel="noopener">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.59 1.1 8.75.73 1.05 1.6 2.24 2.73 2.2 1.1-.05 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.68.97.07 1.96-.5 2.56-1.23z"
                  />
                </svg>
                Unirme a la beta en TestFlight
              </a>
              <span className={s.storeSoon} aria-disabled="true">
                App Store · próximamente
              </span>
            </div>
            <p className={s.req}>Requiere iPhone con iOS 26 o superior y número celular de Colombia.</p>
          </div>
        </section>

        {/* FAQ */}
        <section id="preguntas" className={s.faq} aria-labelledby="faq-title">
          <div className={`container ${s.faqGrid}`}>
            <header>
              <p className={s.kicker}>Preguntas frecuentes</p>
              <h2 id="faq-title" className={s.h2}>
                Lo que nos preguntan.
              </h2>
              <p className={s.sectionLead}>
                ¿Algo más? Escríbenos a <a href="mailto:info@cuypay.com">info@cuypay.com</a>.
              </p>
            </header>
            <div className={s.faqList}>
              {FAQ.map((f, i) => (
                <details key={f.q} className={s.faqItem} id={`faq-${i + 1}`}>
                  <summary>
                    <span>{f.q}</span>
                    <span className={s.faqIcon} aria-hidden />
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}
