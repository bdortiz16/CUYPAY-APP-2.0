import { SiteFooter, SiteHeader, TESTFLIGHT_URL } from "@/components/site/SiteChrome";
import { Isotype } from "@/components/site/Logo";
import s from "./landing.module.css";

const FAQ: { q: string; a: string }[] = [
  {
    q: "¿Qué es Bre-B y cómo funciona mi llave en CuyPay?",
    a: "Bre-B es el sistema de pagos inmediatos interoperable del Banco de la República de Colombia. Con CuyPay creas tu propia llave Bre-B (por ejemplo con tu celular o alias único) para recibir dinero al instante desde cualquier banco o billetera digital de Colombia, 24/7 y sin comisiones.",
  },
  {
    q: "¿Cómo funciona la Tarjeta CuyPay?",
    a: "Desde la app puedes generar tu tarjeta virtual internacional respaldada por Coinsenda. Puedes congelarla, reactivarla o agregarla directamente a Apple Pay para pagar en comercios físicos y compras por internet con el saldo de tu cuenta.",
  },
  {
    q: "¿Cómo convierto divisas sin costo Swift?",
    a: "CuyPay te permite convertir pesos colombianos (COP) a reales brasileños (BRL) y otras divisas con cotización garantizada y transparente, utilizando redes locales inmediatas (Bre-B y PIX) sin intermediarios bancarios Swift costosos.",
  },
  {
    q: "¿Qué necesito para abrir mi cuenta?",
    a: "Solo necesitas tu celular, tu cédula de ciudadanía colombiana y unos minutos para verificar tu identidad mediante reconocimiento facial biométrico.",
  },
  {
    q: "¿Es seguro mi dinero en CuyPay?",
    a: "Totalmente. Tus accesos y operaciones sensibles están asegurados con Face ID en el Secure Enclave de tu dispositivo, y la custodia de fondos se opera en conjunto con entidades financieras autorizadas y vigiladas.",
  },
];

export default function Home() {
  return (
    <div className={s.pageWrapper}>
      <SiteHeader />

      <main>
        {/* HERO SECTION - REPLICA EXACTA DE LA REFERENCIA CUYPAY */}
        <section className={s.heroSection}>
          <div className={s.ambientGlow} aria-hidden />

          <div className={`container ${s.heroGrid}`}>
            {/* COPY IZQUIERDO */}
            <div className={s.heroContent}>
              <div className={s.countryPill}>
                <span className={s.pillDot} />
                <span>Colombia · Brasil y Chile muy pronto</span>
              </div>

              <h1 className={s.heroHeadline}>
                Tu dinero, sin<br />
                fronteras y al<br />
                <span className={s.serifAccent}>mejor precio</span>
              </h1>

              <p className={s.heroSubtitle}>
                Envía, recibe, compra y vende divisas sin costo Swift y con la mejor tasa del mercado colombiano.
              </p>

              <div className={s.heroActions}>
                <a href={TESTFLIGHT_URL} target="_blank" rel="noopener noreferrer" className={s.btnPrimaryCta}>
                  Crea Tu Cuenta CUYPAY
                </a>

                <a href="#como-funciona" className={s.btnVideo}>
                  <span className={s.playCircle}>
                    <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
                      <path d="M11 7L1.25 12.6292L1.25 1.37083L11 7Z" fill="#ffffff" />
                    </svg>
                  </span>
                  <span>Mira cómo funciona</span>
                </a>
              </div>

              <div className={s.socialProof}>
                <div className={s.avatarGroup}>
                  <span className={s.avatarOne} />
                  <span className={s.avatarTwo} />
                  <span className={s.avatarThree} />
                  <span className={s.avatarFour} />
                </div>
                <div className={s.proofText}>
                  <strong>+12.000 personas</strong> ya mueven su dinero con CuyPay
                </div>
              </div>
            </div>

            {/* MOCKUP IPHONE DERECHO CON PILLS FLOTANTES */}
            <div className={s.mockupWrapper}>
              {/* Floating Pill: PIX Brasil */}
              <div className={`${s.floatingBadge} ${s.badgePix}`}>
                <span className={s.flagIcon}>🇧🇷</span>
                <span className={s.badgeLabel}>PIX</span>
              </div>

              {/* Floating Pill: Yape Perú */}
              <div className={`${s.floatingBadge} ${s.badgeYape}`}>
                <span className={s.flagIcon}>🇵🇪</span>
                <span className={s.badgeLabel}>Yape</span>
              </div>

              {/* Floating Pill: Bre-B Colombia */}
              <div className={`${s.floatingBadge} ${s.badgeBreb}`}>
                <span className={s.flagIcon}>🇨🇴</span>
                <span className={s.badgeLabel}>BRE-B</span>
              </div>

              {/* Chasis iPhone */}
              <div className={s.phoneChassis}>
                <div className={s.dynamicIsland} />

                {/* Pantalla Interna de la App */}
                <div className={s.phoneScreen}>
                  {/* Encabezado App */}
                  <div className={s.appHeader}>
                    <div className={s.appBrand}>
                      <span className={s.appLogoBox}>
                        <Isotype size={14} color="#ffffff" />
                      </span>
                      <span className={s.appBrandName}>CuyPay</span>
                    </div>
                    <div className={s.appBell}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    </div>
                  </div>

                  {/* Selector de Tarjeta */}
                  <div className={s.cardSelector}>
                    <span className={s.visaText}>VISA</span>
                    <span className={s.cardDots}>•••• 9587</span>
                    <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
                      <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  </div>

                  {/* Saldo disponible */}
                  <div className={s.balanceBlock}>
                    <span className={s.balanceCaption}>Saldo disponible</span>
                    <h2 className={s.balanceNumber}>$ 2.480.500,00</h2>
                  </div>

                  {/* Tarjetas resumen en fila */}
                  <div className={s.metricsRow}>
                    <div className={s.metricCard}>
                      <div className={s.metricTitle}>Ingresos</div>
                      <div className={s.metricValue}>$ 12.058.000</div>
                      <div className={s.metricSubtitle}>Este mes</div>
                      <div className={s.miniChart}>
                        <span style={{ height: "45%" }} />
                        <span style={{ height: "70%" }} />
                        <span style={{ height: "55%" }} />
                        <span style={{ height: "100%" }} />
                        <span style={{ height: "85%" }} />
                      </div>
                    </div>

                    <div className={s.actionsCard}>
                      <div className={s.metricTitle}>Acciones</div>
                      <div className={s.flagShortcuts}>
                        <span title="PIX">🇧🇷</span>
                        <span title="Yape">🇵🇪</span>
                        <span title="Bre-B">🇨🇴</span>
                      </div>
                      <div className={s.actionsSubtitle}>Envía a 65 países</div>
                    </div>
                  </div>

                  {/* Sección Movimientos */}
                  <div className={s.txSection}>
                    <div className={s.txHeader}>
                      <span className={s.txTitle}>Movimientos</span>
                      <span className={s.txSeeAll}>Ver todo</span>
                    </div>

                    <div className={s.txList}>
                      <div className={s.txItem}>
                        <div className={s.txAvatar}>N</div>
                        <div className={s.txInfo}>
                          <span className={s.txName}>Nómina</span>
                          <span className={s.txMeta}>Ingreso · Nov 12</span>
                        </div>
                        <div className={s.txAmountPositive}>+$ 1.500.000</div>
                      </div>

                      <div className={s.txItem}>
                        <div className={s.txAvatar}>Y</div>
                        <div className={s.txInfo}>
                          <span className={s.txName}>Envío a Perú</span>
                          <span className={s.txMeta}>Yape · Nov 12</span>
                        </div>
                        <div className={s.txAmountNegative}>-$ 320.000</div>
                      </div>
                    </div>
                  </div>

                  {/* Bottom Navigation Bar */}
                  <div className={s.appTabBar}>
                    <div className={s.tabItem}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="7" y1="17" x2="17" y2="7" />
                        <polyline points="7 7 17 7 17 17" />
                      </svg>
                      <span>Enviar</span>
                    </div>

                    <div className={s.tabCenterButton}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      </svg>
                    </div>

                    <div className={s.tabItem}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <polyline points="19 12 12 19 5 12" />
                      </svg>
                      <span>Recibir</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* BENEFICIOS / CARACTERÍSTICAS PRINCIPALES */}
        <section id="productos" className={s.featuresSection}>
          <div className="container">
            <div className={s.sectionHeader}>
              <span className={s.sectionBadge}>DISEÑADO PARA LATINOAMÉRICA</span>
              <h2 className={s.sectionTitle}>
                Todo lo que necesitas para mover tu dinero internacionalmente
              </h2>
            </div>

            <div className={s.featuresGrid}>
              <div className={s.featureCard}>
                <div className={s.featureIcon}>💳</div>
                <h3>Tarjeta CuyPay Internacional</h3>
                <p>
                  Genera tu tarjeta virtual al instante, asóciala a Apple Pay y compra en cualquier comercio del mundo sin cuotas ocultas.
                </p>
              </div>

              <div className={s.featureCard}>
                <div className={s.featureIcon}>⚡️</div>
                <h3>Bre-B & PIX Inmediatos</h3>
                <p>
                  Recibe en Colombia con tu llave propia Bre-B y transfiere a Brasil vía PIX en cuestión de segundos, sin la lentitud bancaria tradicional.
                </p>
              </div>

              <div className={s.featureCard}>
                <div className={s.featureIcon}>🔒</div>
                <h3>Seguridad Biométrica Face ID</h3>
                <p>
                  Firmas criptográficas en el Secure Enclave de tu iPhone, tiempos de inactividad programables y cortina de privacidad automática.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className={s.faqSection}>
          <div className="container">
            <div className={s.sectionHeader}>
              <span className={s.sectionBadge}>PREGUNTAS FRECUENTES</span>
              <h2 className={s.sectionTitle}>Resolvemos tus dudas</h2>
            </div>

            <div className={s.faqGrid}>
              {FAQ.map((item, idx) => (
                <div key={idx} className={s.faqCard}>
                  <h4>{item.q}</h4>
                  <p>{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA BANNER FINAL */}
        <section id="descargar" className={s.ctaSection}>
          <div className="container">
            <div className={s.ctaBanner}>
              <h2>Descarga CuyPay y comienza hoy</h2>
              <p>Disponible en iPhone a través de Apple TestFlight. Regístrate en minutos.</p>
              <a href={TESTFLIGHT_URL} target="_blank" rel="noopener noreferrer" className={s.btnCtaWhite}>
                Descargar en TestFlight
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
