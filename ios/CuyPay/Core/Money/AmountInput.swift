import Foundation

/// Estado de un teclado de montos. Construye el valor en unidades menores dígito a dígito,
/// sin `Double`, con tope máximo y formato es-CO mientras el usuario escribe.
struct AmountInput: Hashable, Sendable {
    let currency: Currency
    /// Permitir decimales (para COP normalmente no: el usuario escribe pesos enteros).
    let allowsFraction: Bool
    /// Tope en unidades menores (evita desbordes y montos absurdos).
    let maxMinorUnits: Int64

    private(set) var integerDigits: String = ""
    private(set) var fractionDigits: String? = nil

    static let maxIntegerDigits = 12

    init(currency: Currency, allowsFraction: Bool? = nil, maxMinorUnits: Int64 = 100_000_000_000_00) {
        self.currency = currency
        self.allowsFraction = allowsFraction ?? (currency == .brl)
        self.maxMinorUnits = maxMinorUnits
    }

    var isEmpty: Bool { integerDigits.isEmpty && fractionDigits == nil }

    /// Valor actual en unidades menores (0 si vacío).
    var minorUnits: Int64 {
        let major = Int64(integerDigits) ?? 0
        var fraction: Int64 = 0
        if let fractionDigits, !fractionDigits.isEmpty {
            let padded = fractionDigits.padding(toLength: currency.minorUnitDigits, withPad: "0", startingAt: 0)
            fraction = Int64(padded) ?? 0
        }
        let (scaled, o1) = major.multipliedReportingOverflow(by: currency.minorUnitsPerMajor)
        let (total, o2) = scaled.addingReportingOverflow(fraction)
        return (o1 || o2) ? maxMinorUnits : total
    }

    var money: Money { Money(minorUnits: minorUnits, currency: currency) }

    /// Agrega un dígito 0-9. Devuelve `false` si se rechazó (tope, dígitos máximos, etc.).
    @discardableResult
    mutating func append(digit: Int) -> Bool {
        guard (0...9).contains(digit) else { return false }
        var candidate = self
        if var fraction = candidate.fractionDigits {
            guard fraction.count < currency.minorUnitDigits else { return false }
            fraction.append(String(digit))
            candidate.fractionDigits = fraction
        } else {
            if candidate.integerDigits.isEmpty && digit == 0 { return false } // sin ceros a la izquierda
            guard candidate.integerDigits.count < Self.maxIntegerDigits else { return false }
            candidate.integerDigits.append(String(digit))
        }
        guard candidate.minorUnits <= maxMinorUnits else { return false }
        self = candidate
        return true
    }

    /// Agrega el separador decimal (`,`).
    @discardableResult
    mutating func appendDecimalSeparator() -> Bool {
        guard allowsFraction, fractionDigits == nil else { return false }
        fractionDigits = ""
        return true
    }

    mutating func deleteBackward() {
        if var fraction = fractionDigits {
            if fraction.isEmpty {
                fractionDigits = nil
            } else {
                fraction.removeLast()
                fractionDigits = fraction
            }
        } else if !integerDigits.isEmpty {
            integerDigits.removeLast()
        }
    }

    mutating func clear() {
        integerDigits = ""
        fractionDigits = nil
    }

    /// Fija el valor desde unidades menores (ej. atajos "$ 50.000").
    mutating func set(minorUnits: Int64) {
        let clamped = max(0, min(minorUnits, maxMinorUnits))
        let major = clamped / currency.minorUnitsPerMajor
        let fraction = clamped % currency.minorUnitsPerMajor
        integerDigits = major == 0 ? "" : String(major)
        if fraction != 0 && allowsFraction {
            let raw = String(fraction)
            fractionDigits = raw.count < 2 ? "0" + raw : raw
        } else {
            fractionDigits = nil
        }
    }

    /// Texto a mostrar mientras se escribe: "1.250.000" o "1.823,5" (sin símbolo).
    var displayString: String {
        let major = UInt64(integerDigits) ?? 0
        var text = Money.groupThousands(major, separator: ".")
        if let fractionDigits {
            text += "," + fractionDigits
        }
        return text
    }
}
