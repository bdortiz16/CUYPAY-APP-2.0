import Foundation

/// Formato de tasas de cambio (no son dinero; usan `Decimal`).
enum RateFormatter {
    private static let locale = Locale(identifier: "es_CO")

    /// COP por 1 BRL, ej. `763,36`.
    static func copPerBRL(_ inverseRate: Decimal) -> String {
        inverseRate.formatted(.number.precision(.fractionLength(2)).locale(locale))
    }

    /// BRL por 1 COP, ej. `0,0013003`.
    static func brlPerCOP(_ rate: Decimal) -> String {
        rate.formatted(.number.precision(.fractionLength(4...7)).locale(locale))
    }

    /// Texto tipo web: `1 BRL = $ 763,36`.
    static func headline(rate: Decimal) -> String {
        guard rate > 0 else { return "—" }
        return "1 BRL = $ " + copPerBRL(1 / rate)
    }

    /// Para gráficas (solo visualización).
    static func double(_ value: Decimal) -> Double {
        NSDecimalNumber(decimal: value).doubleValue
    }

    /// Variación porcentual entre dos tasas, ej. `+1,2 %`.
    static func change(from old: Decimal, to new: Decimal) -> String? {
        guard old != 0 else { return nil }
        let pct = (new - old) / old * 100
        let formatted = pct.formatted(.number.precision(.fractionLength(1)).sign(strategy: .always()).locale(locale))
        return formatted + " %"
    }
}
