import SwiftUI

/// Hoja de detalle de un movimiento / comprobante de recaudo o transferencia.
struct TransactionDetailSheet: View {
    let transaction: WalletTransaction
    let pocket: Currency
    @Environment(\.dismiss) private var dismiss
    @State private var copiedRef = false

    private var isIncoming: Bool {
        if transaction.type == .conversion, let conversion = transaction.conversion {
            return conversion.toCurrency == pocket && transaction.currency != pocket
        }
        return transaction.direction == .in
    }

    private var displayedAmount: Money {
        if transaction.type == .conversion, let conversion = transaction.conversion, isIncoming {
            return conversion.toAmount
        }
        return transaction.amount
    }

    private var iconName: String {
        switch transaction.type {
        case .deposit: "arrow.down.left"
        case .transfer: "arrow.up.right"
        case .conversion: "arrow.left.arrow.right"
        case .cardPocket: isIncoming ? "arrow.uturn.backward.circle" : "creditcard.and.123"
        case .cardPurchase: "bag.fill"
        case .unknown: "circle.dashed"
        }
    }

    private var accentColor: Color {
        switch transaction.type {
        case .cardPocket: return Theme.spruce
        case .cardPurchase: return Theme.ink
        default: return isIncoming ? Theme.positive : Theme.ink
        }
    }

    private var networkTitle: String {
        switch transaction.type {
        case .cardPocket: return "CuyPay · Bolsillo Tarjeta"
        case .cardPurchase: return "Red Visa · Tarjeta CuyPay"
        default: return "ACH Colombia · Bre-B"
        }
    }

    private var statusTitle: String {
        switch transaction.status {
        case .completed:
            switch transaction.type {
            case .cardPocket: return isIncoming ? "Retiro exitoso" : "Recarga exitosa"
            case .cardPurchase: return "Compra aprobada"
            default: return isIncoming ? "Recibido exitosamente" : "Transferencia exitosa"
            }
        case .pending: return "En proceso"
        case .failed: return "No completado"
        case .reversed: return "Reversado"
        case .unknown: return "Procesando"
        }
    }

    private var receiptText: String {
        """
        Comprobante de transacción CuyPay
        Estado: \(statusTitle)
        Tipo: \(transaction.title)
        Monto: \(displayedAmount.formatted(sign: isIncoming ? .always : .never))
        Fecha: \(transaction.createdAt.formatted(date: .long, time: .shortened))
        Referencia: \(transaction.id)
        Red: \(networkTitle)
        """
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                ScrollView {
                    VStack(spacing: 24) {
                        // MARK: Cabecera con ícono y monto
                        VStack(spacing: 12) {
                            Image(systemName: iconName)
                                .font(.system(size: 28, weight: .bold))
                                .foregroundStyle(accentColor)
                                .frame(width: 64, height: 64)
                                .background(accentColor.opacity(0.12), in: .circle)
                                .padding(.top, 16)

                            Text(verbatim: displayedAmount.formatted(sign: isIncoming ? .always : .automatic))
                                .font(.system(.largeTitle, design: .serif).weight(.bold))
                                .monospacedDigit()
                                .foregroundStyle(isIncoming ? Theme.positive : .primary)

                            StatusBadge(
                                text: LocalizedStringKey(statusTitle),
                                color: transaction.status == .completed ? Theme.spruce : Theme.warning,
                                systemImage: transaction.status == .completed ? "checkmark.seal.fill" : "clock.fill"
                            )
                        }

                        // MARK: Ficha de detalles
                        VStack(spacing: 14) {
                            DetailRow(title: "Tipo de movimiento", value: transaction.title)
                            if let subtitle = transaction.subtitle, !subtitle.isEmpty {
                                DetailRow(title: isIncoming ? "Cuenta / Origen" : "Destino / Detalle", value: subtitle)
                            }
                            DetailRow(title: "Fecha y hora", value: transaction.createdAt.formatted(date: .long, time: .shortened))
                            DetailRow(title: "Red de pago", value: networkTitle)

                            if transaction.feeMinor > 0 {
                                DetailRow(title: "Comisión", value: transaction.fee.formatted())
                            } else {
                                DetailRow(title: "Comisión", value: "$ 0 COP (Sin costo)")
                            }

                            if let conv = transaction.conversion {
                                Divider()
                                DetailRow(title: "Moneda de origen", value: conv.fromAmount.formatted())
                                DetailRow(title: "Moneda recibida", value: conv.toAmount.formatted())
                                DetailRow(title: "Tasa aplicada", value: RateFormatter.headline(rate: conv.rate))
                            }

                            Divider()

                            // Referencia con botón para copiar
                            HStack {
                                Text("Referencia")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button {
                                    UIPasteboard.general.string = transaction.id
                                    withAnimation(.snappy) { copiedRef = true }
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                        withAnimation { copiedRef = false }
                                    }
                                } label: {
                                    HStack(spacing: 4) {
                                        Text(verbatim: transaction.id)
                                            .font(.footnote.weight(.semibold))
                                            .monospaced()
                                            .lineLimit(1)
                                        Image(systemName: copiedRef ? "checkmark" : "doc.on.doc")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(copiedRef ? Theme.positive : Theme.spruce)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(20)
                        .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))

                        // MARK: Acciones
                        VStack(spacing: 12) {
                            ShareLink(item: receiptText) {
                                Label("Compartir comprobante", systemImage: "square.and.arrow.up")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 52)
                                    .glassEffect(.regular.interactive(), in: .capsule)
                            }
                            .foregroundStyle(.primary)

                            PrimaryButton(title: "Listo", systemImage: "checkmark") {
                                dismiss()
                            }
                        }
                        .padding(.top, 8)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Detalle del movimiento")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
