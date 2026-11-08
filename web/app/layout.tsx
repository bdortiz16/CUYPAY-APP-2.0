import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT"],
});
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://www.cuypay.com"),
  title: {
    default: "CuyPay — Recibe pesos con Bre-B y conviértelos a reales",
    template: "%s · CuyPay",
  },
  description:
    "Billetera para iPhone: recibe COP con tu propia llave Bre-B, convierte a BRL con tasa transparente y envía por Bre-B. Face ID, KYC y límites claros.",
  applicationName: "CuyPay",
  keywords: ["Bre-B", "COP a BRL", "pesos a reales", "billetera", "Colombia", "Brasil", "llave Bre-B", "CuyPay"],
  authors: [{ name: "XATECH SERVICES S.A.S." }],
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/brand/cuypay-isotipo-spruce.svg", type: "image/svg+xml" }],
    apple: "/brand/cuypay-isotipo-spruce.png",
  },
  openGraph: {
    type: "website",
    locale: "es_CO",
    url: "https://www.cuypay.com/",
    siteName: "CuyPay",
    title: "CuyPay — Tus pesos, en reales, sin vueltas",
    description:
      "Recibe COP con tu llave Bre-B, conviértelos a BRL con comisión visible y envía cuando quieras. Desde tu iPhone.",
    images: [{ url: "/img/og-cuypay.jpg", width: 1200, height: 630, alt: "App CuyPay en un iPhone" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "CuyPay — Tus pesos, en reales, sin vueltas",
    description: "Recibe COP con tu llave Bre-B y conviértelos a BRL desde tu iPhone.",
    images: ["/img/og-cuypay.jpg"],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0C1214",
  colorScheme: "dark light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-CO" className={`${manrope.variable} ${fraunces.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
