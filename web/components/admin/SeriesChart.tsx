"use client";

import { useMemo, useRef, useState } from "react";
import { formatCompactMinor, formatDay, formatMinor } from "@/lib/format";
import type { SeriesPoint } from "@/lib/admin/types";
import { css as s } from "./ui";

const W = 760;
const H = 240;
const PAD = { l: 52, r: 36, t: 12, b: 26 };
const COLORS = { deposits: "#197168", transfers: "#ADCBC8", conversions: "#5E9C95" };

/** Barras apiladas de volumen diario (COP) + línea de clientes nuevos. SVG puro. */
export function SeriesChart({ series }: { series: SeriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const { max, maxCust, ticks } = useMemo(() => {
    const totals = series.map((p) => p.depositsMinor + p.transfersMinor + p.conversionsMinor);
    const rawMax = Math.max(1, ...totals);
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const nice = Math.ceil(rawMax / mag / 2) * 2 * mag;
    return {
      max: nice,
      maxCust: Math.max(4, ...series.map((p) => p.newCustomers)),
      ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice),
    };
  }, [series]);

  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const step = iw / Math.max(1, series.length);
  const bw = Math.max(4, step * 0.62);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const yc = (v: number) => PAD.t + ih - (v / maxCust) * ih;
  const line = series.map((p, i) => `${i ? "L" : "M"}${(PAD.l + i * step + step / 2).toFixed(1)},${yc(p.newCustomers).toFixed(1)}`).join(" ");
  const hp = hover !== null ? series[hover] : null;

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <div className={s.chartLegend} style={{ marginBottom: 10 }}>
        <span>
          <i style={{ background: COLORS.deposits }} /> Depósitos
        </span>
        <span>
          <i style={{ background: COLORS.transfers }} /> Envíos
        </span>
        <span>
          <i style={{ background: COLORS.conversions }} /> Conversiones
        </span>
        <span>
          <i style={{ background: "transparent", borderTop: "2px dashed #E1E3EA", borderRadius: 0, height: 0 }} /> Clientes nuevos
        </span>
        <span>
          <i style={{ background: "#FA6465", borderRadius: "50%", width: 7, height: 7 }} /> Hoy
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={s.chart}
        role="img"
        aria-label="Volumen diario de los últimos 30 días"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="rgba(173,203,200,0.08)" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="rgba(232,238,238,0.45)">
              {formatCompactMinor(t, "COP").replace("$ ", "")}
            </text>
          </g>
        ))}
        <text x={W - PAD.r + 8} y={PAD.t + 8} fontSize="10" fill="rgba(232,238,238,0.45)">
          {maxCust}
        </text>
        {series.map((p, i) => {
          const x = PAD.l + i * step + (step - bw) / 2;
          let acc = 0;
          const segs = (["deposits", "transfers", "conversions"] as const).map((k) => {
            const v = p[`${k}Minor`];
            const y0 = y(acc);
            acc += v;
            const y1 = y(acc);
            return <rect key={k} x={x} y={y1} width={bw} height={Math.max(0, y0 - y1)} fill={COLORS[k]} opacity={hover === null || hover === i ? 1 : 0.45} />;
          });
          const isToday = i === series.length - 1;
          return (
            <g key={p.date}>
              {segs}
              {isToday ? <circle cx={x + bw / 2} cy={y(acc) - 7} r={3.5} fill="#FA6465" /> : null}
              <rect
                x={PAD.l + i * step}
                y={PAD.t}
                width={step}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                tabIndex={-1}
              />
              {i % 5 === 0 || isToday ? (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill={isToday ? "#FA6465" : "rgba(232,238,238,0.45)"}>
                  {isToday ? "Hoy" : formatDay(p.date)}
                </text>
              ) : null}
            </g>
          );
        })}
        <path d={line} fill="none" stroke="#E1E3EA" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="4 3" pointerEvents="none" />
      </svg>
      {hp && hover !== null ? (
        <div
          className={s.tooltip}
          style={{
            left: `${((PAD.l + hover * step + step / 2) / W) * 100}%`,
            top: `${(y(hp.depositsMinor + hp.transfersMinor + hp.conversionsMinor) / H) * 100}%`,
            marginTop: 30,
          }}
        >
          <strong>{formatDay(hp.date)}</strong>
          <div>Depósitos: {formatMinor(hp.depositsMinor, "COP")}</div>
          <div>Envíos: {formatMinor(hp.transfersMinor, "COP")}</div>
          <div>Conversiones: {formatMinor(hp.conversionsMinor, "COP")}</div>
          <div>Clientes nuevos: {hp.newCustomers}</div>
        </div>
      ) : null}
    </div>
  );
}
