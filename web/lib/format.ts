import type { Currency } from "./admin/types";

// Formato de dinero a partir de unidades menores (enteros). Nunca se usa float para sumar dinero;
// solo se convierte a texto al final.
export function formatMinor(minor: number, currency: Currency, opts: { decimals?: boolean; sign?: boolean } = {}): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const units = Math.floor(abs / 100);
  const cents = abs % 100;
  const showDecimals = opts.decimals ?? currency === "BRL";
  const intPart = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const body = showDecimals ? `${intPart},${cents.toString().padStart(2, "0")}` : intPart;
  const symbol = currency === "BRL" ? "R$ " : "$ ";
  const sign = negative ? "−" : opts.sign && minor > 0 ? "+" : "";
  return `${sign}${symbol}${body}`;
}

export function formatCompactMinor(minor: number, currency: Currency): string {
  const units = minor / 100;
  const symbol = currency === "BRL" ? "R$ " : "$ ";
  const abs = Math.abs(units);
  if (abs >= 1e9) return `${symbol}${(units / 1e9).toFixed(1).replace(".", ",")} mil M`;
  if (abs >= 1e6) return `${symbol}${(units / 1e6).toFixed(1).replace(".", ",")} M`;
  if (abs >= 1e3) return `${symbol}${(units / 1e3).toFixed(0)} mil`;
  return `${symbol}${units.toFixed(0)}`;
}

export function formatInt(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const dtf = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const df = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", timeZone: "America/Bogota" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dtf.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return df.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso));
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `hace ${Math.max(s, 0)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** Convierte texto "1.234.567,89" o "1234567" a unidades menores (entero). */
export function parseToMinor(text: string): number | null {
  const clean = text.replace(/[^\d,]/g, "");
  if (!clean) return null;
  const [intPart, decPart = ""] = clean.split(",");
  const units = Number.parseInt(intPart || "0", 10);
  const cents = Number.parseInt((decPart + "00").slice(0, 2), 10);
  if (!Number.isFinite(units)) return null;
  return units * 100 + cents;
}

export function pct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits).replace(".", ",")} %`;
}
