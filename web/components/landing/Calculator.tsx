"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { customerRateFrom, DEMO_FX, quote } from "@/lib/fx";
import { formatMinor } from "@/lib/format";
import s from "./calculator.module.css";

const PRESETS = [200_000, 500_000, 1_000_000, 3_000_000];
const QUOTE_SECONDS = 30;
const MAX_COP = 20_000_000;

function groupDigits(n: number) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function Calculator() {
  const [pesos, setPesos] = useState(1_000_000); // unidades enteras de COP (sin centavos)
  const [mid, setMid] = useState(DEMO_FX.midRate);
  const [left, setLeft] = useState(QUOTE_SECONDS);

  // Cotización "en vivo" simulada: cada 30 s la tasa media se mueve un poco.
  const counter = useRef(0);
  useEffect(() => {
    const iv = setInterval(() => {
      counter.current += 1;
      if (counter.current >= QUOTE_SECONDS) {
        counter.current = 0;
        const drift = 1 + (Math.random() - 0.5) * 0.004;
        setMid((m) => Math.min(DEMO_FX.midRate * 1.02, Math.max(DEMO_FX.midRate * 0.98, m * drift)));
      }
      setLeft(QUOTE_SECONDS - counter.current);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const params = useMemo(
    () => ({ customerRate: customerRateFrom(mid, DEMO_FX.spreadBps), feeBps: DEMO_FX.feeBps, minFeeMinor: DEMO_FX.minFeeMinor }),
    [mid],
  );
  const q = useMemo(() => quote(pesos * 100, params), [pesos, params]);
  const brlPerMillion = useMemo(() => quote(100_000_000, { ...params, feeBps: 0, minFeeMinor: 0 }).toAmountMinor, [params]);

  const onInput = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 9);
    const n = digits ? Number.parseInt(digits, 10) : 0;
    setPesos(Math.min(n, MAX_COP));
  };

  const tooLow = pesos > 0 && q.netMinor <= 0;

  return (
    <div className={s.card} aria-labelledby="calc-title">
      <div className={s.head}>
        <h2 id="calc-title" className={s.title}>Simula tu conversión</h2>
        <span className={s.live} aria-live="off">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <circle cx="10" cy="10" r="8" className={s.ringBg} />
            <circle
              cx="10"
              cy="10"
              r="8"
              className={s.ring}
              style={{ strokeDashoffset: `${50.27 * (1 - left / QUOTE_SECONDS)}` }}
            />
          </svg>
          Tasa se actualiza en {left} s
        </span>
      </div>

      <label className={s.field} htmlFor="calc-cop">
        <span className={s.fieldLabel}>Conviertes</span>
        <span className={s.fieldRow}>
          <span className={s.prefix}>$</span>
          <input
            id="calc-cop"
            className={`${s.input} num`}
            inputMode="numeric"
            autoComplete="off"
            value={pesos ? groupDigits(pesos) : ""}
            placeholder="0"
            onChange={(e) => onInput(e.target.value)}
            aria-describedby="calc-breakdown"
          />
          <span className={s.ccy}>
            <span className={s.flag} aria-hidden>🇨🇴</span> COP
          </span>
        </span>
      </label>

      <div className={s.presets} role="group" aria-label="Montos rápidos">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            id={`calc-preset-${p}`}
            className={`${s.preset} ${pesos === p ? s.presetOn : ""}`}
            onClick={() => setPesos(p)}
          >
            {p >= 1_000_000 ? `${p / 1_000_000} M` : `${p / 1000} mil`}
          </button>
        ))}
      </div>

      <div className={s.result}>
        <span className={s.fieldLabel}>Recibes en tu bolsillo BRL</span>
        <span className={s.resultRow}>
          <output className={`${s.resultValue} num`} htmlFor="calc-cop" aria-live="polite">
            {tooLow ? "—" : formatMinor(q.toAmountMinor, "BRL")}
          </output>
          <span className={s.ccy}>
            <span className={s.flag} aria-hidden>🇧🇷</span> BRL
          </span>
        </span>
      </div>

      <dl className={s.breakdown} id="calc-breakdown">
        <div>
          <dt>Comisión ({(DEMO_FX.feeBps / 100).toString().replace(".", ",")} %, mín. $ 2.000)</dt>
          <dd className="num">{formatMinor(q.feeMinor, "COP")}</dd>
        </div>
        <div>
          <dt>Monto que se convierte</dt>
          <dd className="num">{formatMinor(Math.max(q.netMinor, 0), "COP")}</dd>
        </div>
        <div>
          <dt>Tasa aplicada</dt>
          <dd className="num">$ 1.000.000 = {formatMinor(brlPerMillion, "BRL")}</dd>
        </div>
      </dl>

      {tooLow ? <p className={s.warn}>El monto no cubre la comisión mínima.</p> : null}

      <a href="#descargar" className={`btn ${s.cta}`} id="calc-cta">
        Quiero convertir con CuyPay
      </a>
      <p className={s.disclaimer}>
        Tasa de referencia para demostración. En la app ves la cotización real, fija por 30 segundos, antes de confirmar con Face ID.
      </p>
    </div>
  );
}
