import Link from "next/link";
import { Logo } from "./Logo";
import s from "./site.module.css";

// Enlace público de TestFlight. Mientras no exista, se pide acceso por correo.
export const TESTFLIGHT_URL =
  process.env.NEXT_PUBLIC_TESTFLIGHT_URL || "mailto:info@cuypay.com?subject=Quiero%20probar%20la%20beta%20de%20CuyPay";

export function SiteHeader() {
  return (
    <header className={s.header}>
      <div className={`container ${s.headerInner}`}>
        <Link href="/" className={s.brand} aria-label="CuyPay, inicio">
          <Logo size={26} color="#fff" />
        </Link>
        <nav className={s.nav} aria-label="Principal">
          <Link href="/#como-funciona">Cómo funciona</Link>
          <Link href="/#bolsillos">Bolsillos</Link>
          <Link href="/#seguridad">Seguridad</Link>
          <Link href="/#preguntas">Preguntas</Link>
        </nav>
        <Link href="/#descargar" className={`btn btn-light ${s.headerCta}`} id="header-descargar">
          Descargar beta
        </Link>
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
            <Logo size={24} color="#fff" />
            <p>Recibe pesos con tu propia llave Bre-B, conviértelos a reales con la comisión a la vista y envía cuando lo necesites.</p>
          </div>
          <div className={s.footerCol}>
            <h3>Producto</h3>
            <ul>
              <li><Link href="/#como-funciona">Cómo funciona</Link></li>
              <li><Link href="/#bolsillos">Bolsillos COP y BRL</Link></li>
              <li><Link href="/#seguridad">Seguridad</Link></li>
              <li><Link href="/#descargar">Descargar</Link></li>
            </ul>
          </div>
          <div className={s.footerCol}>
            <h3>Legal</h3>
            <ul>
              <li><Link href="/privacidad/">Política de privacidad</Link></li>
              <li><Link href="/terminos/">Términos y condiciones</Link></li>
            </ul>
          </div>
          <div className={s.footerCol}>
            <h3>Contacto</h3>
            <ul>
              <li><a href="mailto:info@cuypay.com">info@cuypay.com</a></li>
              <li>Bogotá, Colombia</li>
            </ul>
          </div>
        </div>
        <div className={s.footerBottom}>
          <span>
            <strong>CuyPay es una marca de XATECH SERVICES S.A.S.</strong> © {year}
          </span>
          <span>CuyPay no es un banco. Los servicios de pago se prestan con aliados autorizados.</span>
        </div>
      </div>
    </footer>
  );
}
