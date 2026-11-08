import Foundation
import Testing
@testable import CuyPay

@Suite("Money — formato y parseo sin Double")
struct MoneyTests {
    // MARK: Formato

    @Test("COP sin centavos: $ 1.250.000")
    func copWholePesos() {
        #expect(Money(minorUnits: 125_000_000, currency: .cop).formatted() == "$ 1.250.000")
    }

    @Test("COP con centavos: $ 1.250.000,50")
    func copWithCents() {
        #expect(Money(minorUnits: 125_000_050, currency: .cop).formatted() == "$ 1.250.000,50")
        #expect(Money(minorUnits: 5, currency: .cop).formatted() == "$ 0,05")
    }

    @Test("BRL siempre con 2 decimales: R$ 1.823,00")
    func brl() {
        #expect(Money(minorUnits: 182_300, currency: .brl).formatted() == "R$ 1.823,00")
        #expect(Money(minorUnits: 128_729, currency: .brl).formatted() == "R$ 1.287,29")
        #expect(Money(minorUnits: 0, currency: .brl).formatted() == "R$ 0,00")
    }

    @Test("Signos: automático, siempre, nunca")
    func signs() {
        let out = Money(minorUnits: -5_000_000, currency: .cop)
        let income = Money(minorUnits: 5_000_000, currency: .cop)
        #expect(out.formatted() == "-$ 50.000")
        #expect(out.formatted(sign: .always) == "-$ 50.000")
        #expect(income.formatted(sign: .always) == "+$ 50.000")
        #expect(out.formatted(sign: .never) == "$ 50.000")
        #expect(Money.zero(.cop).formatted(sign: .always) == "$ 0")
        #expect(income.formatted(includeSymbol: false) == "50.000")
    }

    @Test("Agrupación de miles", arguments: [
        (UInt64(0), "0"), (999, "999"), (1_000, "1.000"), (1_234_567, "1.234.567"), (100_000_000, "100.000.000"),
    ])
    func grouping(value: UInt64, expected: String) {
        #expect(Money.groupThousands(value, separator: ".") == expected)
    }

    @Test("Modo oculto no revela el monto")
    func masked() {
        #expect(Money(minorUnits: 125_000_000, currency: .cop).maskedString == "$ ••••••")
    }

    // MARK: Aritmética

    @Test("Suma/resta verificadas")
    func arithmetic() {
        let a = Money(minorUnits: 100, currency: .cop)
        #expect(a.adding(Money(minorUnits: 50, currency: .cop))?.minorUnits == 150)
        #expect(a.adding(Money(minorUnits: 50, currency: .brl)) == nil)
        #expect(Money(minorUnits: .max, currency: .cop).adding(a) == nil)
        #expect(a.subtracting(Money(minorUnits: 150, currency: .cop))?.minorUnits == -50)
        #expect(Money(major: .max, currency: .cop) == nil)
        #expect(Money(major: 150_000, currency: .cop)?.minorUnits == 15_000_000)
    }

    // MARK: Parseo

    @Test("Parseo válido", arguments: [
        ("1.250.000", Currency.cop, Int64(125_000_000)),
        ("$ 1.250.000,5", .cop, 125_000_050),
        ("$ 1.250.000,50", .cop, 125_000_050),
        ("R$ 1.823,00", .brl, 182_300),
        ("1823,5", .brl, 182_350),
        ("-20.000", .cop, -2_000_000),
        (",5", .brl, 50),
        ("0", .cop, 0),
    ])
    func parseValid(text: String, currency: Currency, expected: Int64) {
        #expect(Money.parse(text, currency: currency)?.minorUnits == expected)
    }

    @Test("Parseo inválido", arguments: [
        "", "abc", "1,234", "1,2,3", "12a", "١٢٣", "99999999999999999999", "$", ",",
    ])
    func parseInvalid(text: String) {
        #expect(Money.parse(text, currency: .cop) == nil)
    }

    @Test("Formato → parseo es ida y vuelta")
    func roundTrip() {
        for minor: Int64 in [0, 1, 99, 100, 125_000_050, 182_300, -2_000_000] {
            for currency in Currency.allCases {
                let money = Money(minorUnits: minor, currency: currency)
                #expect(Money.parse(money.formatted(), currency: currency) == money)
            }
        }
    }
}

@Suite("AmountInput — teclado de montos")
struct AmountInputTests {
    @Test("COP: enteros, sin ceros a la izquierda ni decimales")
    func copInput() {
        var input = AmountInput(currency: .cop)
        let accepted1 = input.append(digit: 0)
        #expect(!accepted1)
        for digit in [1, 2, 5, 0, 0, 0, 0] { input.append(digit: digit) }
        #expect(input.minorUnits == 125_000_000)
        #expect(input.displayString == "1.250.000")
        let accepted2 = input.appendDecimalSeparator()
        #expect(!accepted2)
        input.deleteBackward()
        #expect(input.displayString == "125.000")
        input.clear()
        #expect(input.isEmpty)
        #expect(input.minorUnits == 0)
        #expect(input.displayString == "0")
    }

    @Test("BRL: hasta 2 decimales")
    func brlInput() {
        var input = AmountInput(currency: .brl)
        for digit in [1, 8, 2, 3] { input.append(digit: digit) }
        let accepted3 = input.appendDecimalSeparator()
        #expect(accepted3)
        let accepted4 = input.appendDecimalSeparator()
        #expect(!accepted4)
        input.append(digit: 5)
        #expect(input.displayString == "1.823,5")
        #expect(input.minorUnits == 182_350)
        input.append(digit: 7)
        let accepted5 = input.append(digit: 9)
        #expect(!accepted5)
        #expect(input.minorUnits == 182_357)
        input.deleteBackward()
        input.deleteBackward()
        input.deleteBackward()
        #expect(input.displayString == "1.823")
    }

    @Test("Respeta el tope máximo")
    func maximum() {
        var input = AmountInput(currency: .cop, maxMinorUnits: 10_000_000) // $ 100.000
        for digit in [1, 0, 0, 0, 0, 0] {
            let accepted = input.append(digit: digit)
            #expect(accepted)
        }
        let accepted6 = input.append(digit: 0)
        #expect(!accepted6)
        #expect(input.minorUnits == 10_000_000)
    }

    @Test("set(minorUnits:) rellena correctamente")
    func setMinorUnits() {
        var brl = AmountInput(currency: .brl)
        brl.set(minorUnits: 182_305)
        #expect(brl.displayString == "1.823,05")
        #expect(brl.minorUnits == 182_305)

        var cop = AmountInput(currency: .cop)
        cop.set(minorUnits: 5_000_000)
        #expect(cop.displayString == "50.000")
        cop.set(minorUnits: -10)
        #expect(cop.minorUnits == 0)
    }
}
