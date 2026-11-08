import Foundation

/// Datos demo realistas (Colombia, nov. 2026) para `MockAPIClient` y previews de SwiftUI.
struct MockFixtures: Sendable {
    let now: Date

    private func ago(days: Double = 0, hours: Double = 0, minutes: Double = 0) -> Date {
        now.addingTimeInterval(-(days * 86_400 + hours * 3_600 + minutes * 60))
    }

    var user: User {
        User(
            id: "usr_7Hk2pQ9",
            firstName: "Ana",
            lastName: "Gómez",
            email: "ana.gomez@correo.co",
            phone: "+573001234567",
            country: "CO",
            kycStatus: .approved,
            tier: .full,
            createdAt: ago(days: 120)
        )
    }

    var wallets: [Wallet] {
        [
            Wallet(currency: .cop, balanceMinor: 125_000_000, availableMinor: 120_000_000, heldMinor: 5_000_000),
            Wallet(currency: .brl, balanceMinor: 182_300, availableMinor: 182_300, heldMinor: 0),
        ]
    }

    var brebKey: BrebKey {
        BrebKey(id: "brk_a1b2c3", alias: "@cuypayana123", status: .active, holderName: "Ana Gómez", createdAt: ago(days: 100))
    }

    var cards: [CardItem] {
        [
            CardItem(
                id: "crd_mock_ana",
                cardType: "virtual",
                status: .active,
                label: "CuyPay Virtual",
                lastFour: "4242",
                brand: "Mastercard",
                currency: .cop,
                createdAt: ago(days: 15),
                updatedAt: ago(days: 15)
            )
        ]
    }

    var beneficiaries: [Beneficiary] {
        [
            Beneficiary(id: "ben_juan", alias: "3001234567", holderName: "Juan Pérez", nickname: "Juan", bankName: "Bancolombia",
                        status: .active, aml: AMLCheck(provider: "sartblock", result: .clear, referenceId: "aml_001", checkedAt: ago(days: 60)), createdAt: ago(days: 60)),
            Beneficiary(id: "ben_maria", alias: "maria.rodriguez@correo.co", holderName: "María Rodríguez", nickname: "Mamá", bankName: "Davivienda",
                        status: .active, aml: AMLCheck(provider: "sartblock", result: .clear, referenceId: "aml_002", checkedAt: ago(days: 45)), createdAt: ago(days: 45)),
            Beneficiary(id: "ben_laura", alias: "@laurapay", holderName: "Laura Martínez", nickname: nil, bankName: "Banco de Bogotá",
                        status: .active, aml: AMLCheck(provider: "sartblock", result: .clear, referenceId: "aml_003", checkedAt: ago(days: 30)), createdAt: ago(days: 30)),
            Beneficiary(id: "ben_andres", alias: "1020304050", holderName: "Andrés Torres", nickname: "Andrés", bankName: "Nequi",
                        status: .active, aml: AMLCheck(provider: "sartblock", result: .clear, referenceId: "aml_004", checkedAt: ago(days: 12)), createdAt: ago(days: 12)),
            Beneficiary(id: "ben_carlos", alias: "3159998888", holderName: "Carlos Ruiz", nickname: nil, bankName: "Banco de Occidente",
                        status: .pendingReview, aml: AMLCheck(provider: "sartblock", result: .review, referenceId: "aml_005", checkedAt: ago(days: 1)), createdAt: ago(days: 1)),
        ]
    }

    var transactions: [WalletTransaction] {
        [
            WalletTransaction(id: "txn_001", type: .deposit, direction: .in, currency: .cop, amountMinor: 50_000_000, feeMinor: 0, status: .completed,
                              title: "Pedro Salazar", subtitle: "Bre-B · @cuypayana123", conversion: nil, createdAt: ago(hours: 2)),
            WalletTransaction(id: "txn_002", type: .transfer, direction: .out, currency: .cop, amountMinor: 5_000_000, feeMinor: 0, status: .completed,
                              title: "Juan Pérez", subtitle: "Bre-B · 3001234567", conversion: nil, createdAt: ago(hours: 5)),
            WalletTransaction(id: "txn_003", type: .conversion, direction: .out, currency: .cop, amountMinor: 100_000_000, feeMinor: 1_000_000, status: .completed,
                              title: "Conversión a BRL", subtitle: "COP → BRL",
                              conversion: ConversionDetail(fromCurrency: .cop, fromAmountMinor: 100_000_000, toCurrency: .brl, toAmountMinor: 128_734, rate: Decimal(string: "0.0013003")!),
                              createdAt: ago(days: 1, hours: 3)),
            WalletTransaction(id: "txn_004", type: .transfer, direction: .out, currency: .cop, amountMinor: 18_000_000, feeMinor: 0, status: .pending,
                              title: "María Rodríguez", subtitle: "Bre-B · maria.rodriguez@correo.co", conversion: nil, createdAt: ago(days: 1, hours: 6)),
            WalletTransaction(id: "txn_005", type: .deposit, direction: .in, currency: .cop, amountMinor: 230_000_000, feeMinor: 0, status: .completed,
                              title: "Nómina Acme S.A.S.", subtitle: "Bre-B · @cuypayana123", conversion: nil, createdAt: ago(days: 3)),
            WalletTransaction(id: "txn_006", type: .transfer, direction: .out, currency: .cop, amountMinor: 7_500_000, feeMinor: 0, status: .failed,
                              title: "Laura Martínez", subtitle: "Bre-B · @laurapay", conversion: nil, createdAt: ago(days: 4)),
            WalletTransaction(id: "txn_007", type: .conversion, direction: .out, currency: .cop, amountMinor: 40_000_000, feeMinor: 400_000, status: .completed,
                              title: "Conversión a BRL", subtitle: "COP → BRL",
                              conversion: ConversionDetail(fromCurrency: .cop, fromAmountMinor: 40_000_000, toCurrency: .brl, toAmountMinor: 53_566, rate: Decimal(string: "0.0013526")!),
                              createdAt: ago(days: 6)),
            WalletTransaction(id: "txn_008", type: .deposit, direction: .in, currency: .cop, amountMinor: 12_000_000, feeMinor: 0, status: .completed,
                              title: "Andrés Torres", subtitle: "Bre-B · @cuypayana123", conversion: nil, createdAt: ago(days: 8)),
        ]
    }

    var limits: LimitsSnapshot {
        LimitsSnapshot(tier: .full, currency: .cop, items: [
            LimitItem(operation: .transferOut, period: .daily, limitMinor: 300_000_000, usedMinor: 23_000_000),
            LimitItem(operation: .transferOut, period: .monthly, limitMinor: 2_000_000_000, usedMinor: 305_000_000),
            LimitItem(operation: .transferOut, period: .annual, limitMinor: 15_000_000_000, usedMinor: 2_480_000_000),
            LimitItem(operation: .conversion, period: .daily, limitMinor: 200_000_000, usedMinor: 0),
            LimitItem(operation: .conversion, period: .monthly, limitMinor: 1_500_000_000, usedMinor: 140_000_000),
            LimitItem(operation: .depositIn, period: .monthly, limitMinor: 2_000_000_000, usedMinor: 292_000_000),
        ])
    }

    var devices: [Device] {
        [
            Device(id: "dev_iphone", name: "iPhone de Ana", createdAt: ago(days: 120), lastUsedAt: now, current: true),
            Device(id: "dev_ipad", name: "iPad de Ana", createdAt: ago(days: 40), lastUsedAt: ago(days: 9), current: false),
        ]
    }

    /// Tasa COP→BRL con historia de 30 días (onda suave determinística alrededor de 0,00131).
    static func rate(now: Date) -> FxRate {
        let calendar = Calendar(identifier: .gregorian)
        let today = calendar.startOfDay(for: now)
        let base = Decimal(string: "0.0013100")!
        let offsets: [Int] = [12, 18, 9, -4, -11, -6, 3, 14, 21, 17, 8, -2, -9, -15, -10, 1, 7, 15, 24, 19, 10, 4, -3, -8, -1, 6, 11, 5, -2, -10]
        var history: [FxRatePoint] = []
        for (index, offset) in offsets.enumerated() {
            let day = calendar.date(byAdding: .day, value: index - (offsets.count - 1), to: today) ?? today
            history.append(FxRatePoint(date: day, rate: base + Decimal(offset) / Decimal(100_000)))
        }
        let current = history.last?.rate ?? base
        // inverseRate = COP por 1 BRL ≈ 1 / rate (redondeado a 2 decimales).
        var inverse = Decimal(1) / current
        var roundedInverse = Decimal()
        NSDecimalRound(&roundedInverse, &inverse, 2, .plain)
        return FxRate(from: .cop, to: .brl, rate: current, inverseRate: roundedInverse, updatedAt: now, history: history)
    }
}
