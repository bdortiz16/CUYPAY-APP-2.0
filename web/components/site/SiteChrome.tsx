import Link from "next/link";
import { Isotype } from "./Logo";
import s from "./site.module.css";

export const TESTFLIGHT_URL =
  process.env.NEXT_PUBLIC_TESTFLIGHT_URL || "https://testflight.apple.com/join/cuypay";

export function SiteHeader() {
  return (
    <header className={s.headerContainer}>
      <div className={s.headerPill}>
        <div className={s.headerLeft}>
          <Link href="/" className={s.brand} aria-label="CuyPay, inicio">
            <span className={s.brandBadge}>
              <Isotype size={18} color="#ffffff" />
            </span>
            <span className={s.brandText}>CUYPAY</span>
          </Link>

          <div className={s.segmentTabs}>
            <span className={`${s.segmentTab} ${s.segmentActive}`}>PERSONAS</span>
            <span className={s.segmentTab}>EMPRESAS</span>
          </div>

          <nav className={s.navLinks} aria-label="Principal">
            <Link href="#productos" className={s.navLink}>Productos</Link>
            <div className={s.dropdownLink}>
              <span>Beneficios</span>
              <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </div>
          </nav>
        </div>

        <div className={s.headerRight}>
          <div className={s.countrySelector}>
            <span className={s.flag}>🇨🇴</span>
            <span className={s.countryCode}>CO</span>
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
              <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </div>

          <Link href="/admin-portal" className={s.loginLink}>
            Iniciar sesión
          </Link>

          <a href="#descargar" className={s.ctaButton}>
            Crear cuenta
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className={s.footer}>
      <div className="container">
        <div className={s.footerGrid}>
          <div className={s.footerBrand}>
            <div className={s.footerLogo}>
              <span className={s.brandBadge}>
                <Isotype size={18} color="#ffffff" />
              </span>
              <span className={s.brandTextDark}>CUYPAY</span>
            </div>
            <p>
              Envía, recibe, compra y vende divisas sin costo Swift y con la mejor tasa del mercado colombiano.
            </p>
          </div>
          <div className={s.footerCol}>
            <h4>Productos</h4>
            <ul>
              <li><a href="#tarjeta">Tarjeta CuyPay</a></li>
              <li><a href="#breb">Llave Bre-B (Colombia)</a></li>
              <li><a href="#pix">PIX (Brasil)</a></li>
              <li><a href="#convertir">Conversión de divisas</a></li>
            </ul>
          </div>
          <div className={s.footerCol}>
            <h4>Legal</h4>
            <ul>
              <li><Link href="/privacidad/">Política de privacidad</Link></li>
              <li><Link href="/terminos/">Términos y condiciones</Link></li>
              <li><Link href="/admin-portal/">Portal administrativo</Link></li>
            </ul>
          </div>
          <div className={s.footerCol}>
            <h4>Contacto</h4>
            <ul>
              <li><a href="mailto:info@cuypay.com">info@cuypay.com</a></li>
              <li>NIT: 901799579</li>
              <li>Bogotá, Colombia</li>
            </ul>
          </div>
        </div>
        <div className={s.footerBottom}>
          <span>
            <strong>CuyPay</strong> es una marca registrada de <strong>XATECH SERVICES S.A.S.</strong> © {year}
          </span>
          <span>CuyPay no es un banco. La custodia y emisión se realiza mediante aliados vigilados y autorizados.</span>
        </div>
      </div>
    </footer>
  );
}
