import { SiteFooter, SiteHeader } from "./SiteChrome";
import s from "./legal.module.css";

export function LegalPage({
  title,
  updated,
  toc,
  children,
}: {
  title: string;
  updated: string;
  toc: { id: string; label: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className={s.page}>
      <SiteHeader />
      <main>
        <section className={s.hero}>
          <div className="container">
            <h1>{title}</h1>
            <p className={s.meta}>Última actualización: {updated} · XATECH SERVICES S.A.S. (CuyPay)</p>
            <p className={s.draft} role="note">
              <strong>Borrador</strong>
              <span>
                Este documento es un borrador pendiente de revisión legal. Puede cambiar antes del lanzamiento público de CuyPay
                y no constituye todavía la versión vigente.
              </span>
            </p>
          </div>
        </section>
        <div className={`container ${s.layout}`}>
          <nav className={s.toc} aria-label="Contenido">
            <p>Contenido</p>
            <ol>
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`}>{t.label}</a>
                </li>
              ))}
            </ol>
          </nav>
          <article className={s.content}>{children}</article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
