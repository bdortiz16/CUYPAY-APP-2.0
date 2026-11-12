import LinkPresentation
import SwiftUI
import UIKit

// MARK: - Comprobante Oficial CuyPay (Pantalla + Exportación de Imagen @3x)

/// Tarjeta ejecutiva tipo ticket bancario para comprobantes de envío Bre-B, movimientos y conversiones.
/// Usa únicamente primitivas vectoriales de SwiftUI (sin `UIVisualEffectView`) para que `ImageRenderer`
/// genere un PNG `@3x` idéntico y nítido al compartir por WhatsApp, Mensajes, Correo o Guardar en Fotos.
struct CuyPayVoucherCard: View {
    let transaction: WalletTransaction
    var pocket: Currency? = nil
    var senderName: String? = nil
    /// En modo exportación ocultamos controles interactivos ("Copiar") y mostramos el sello completo.
    var isExporting: Bool = false
    var copiedReference: Bool = false
    var onCopyReference: (() -> Void)? = nil

    private var effectivePocket: Currency {
        pocket ?? transaction.currency
    }

    private var isIncoming: Bool {
        if transaction.type == .conversion, let conversion = transaction.conversion {
            return conversion.toCurrency == effectivePocket && transaction.currency != effectivePocket
        }
        return transaction.direction == .in
    }

    private var displayedAmount: Money {
        if transaction.type == .conversion, let conversion = transaction.conversion {
            return conversion.toAmount
        }
        return transaction.amount
    }

    private var statusPalette: (color: Color, icon: String, headline: String, subheadline: String?) {
        let mint = Color(red: 0.30, green: 0.88, blue: 0.76)
        let amber = Color(red: 0.96, green: 0.73, blue: 0.28)
        let coral = Color(red: 0.96, green: 0.38, blue: 0.40)

        switch transaction.status {
        case .completed:
            switch transaction.type {
            case .deposit:
                return (mint, "arrow.down.left.circle.fill", "Depósito recibido", "Acreditado en tu cuenta CuyPay")
            case .transfer:
                return (
                    mint,
                    "checkmark",
                    isIncoming ? "Transferencia recibida" : "¡Transferencia exitosa!",
                    "Liquidación inmediata Bre-B"
                )
            case .conversion:
                return (mint, "arrow.left.arrow.right", "¡Conversión exitosa!", "Acreditado al instante")
            case .cardPocket:
                return (
                    mint,
                    "creditcard.fill",
                    isIncoming ? "Retiro desde tarjeta" : "Recarga de tarjeta exitosa",
                    "Movimiento instantáneo sin costo"
                )
            case .cardPurchase:
                return (mint, "bag.fill", "Compra aprobada", "Tarjeta Virtual CuyPay Visa")
            case .savings:
                return (
                    mint,
                    "lock.rotation",
                    isIncoming ? "Reintegro de ahorro exitoso" : "Bolsillo de ahorro constituido",
                    "Rendimiento fijo garantizado"
                )
            case .loan:
                return (
                    mint,
                    "banknote.fill",
                    isIncoming ? "Crédito desembolsado" : "Pago de crédito aplicado",
                    "Créditos CuyPay"
                )
            case .unknown:
                return (mint, "checkmark", "Operación exitosa", nil)
            }

        case .pending, .unknown:
            if transaction.type == .transfer && !isIncoming {
                return (
                    amber,
                    "paperplane.fill",
                    "Envío Bre-B emitido",
                    "Confirmando acreditación inmediata en red Bre-B"
                )
            }
            return (amber, "clock.fill", "Operación en proceso", "Validando confirmación en la red")

        case .failed:
            return (coral, "xmark", "Operación no completada", "No se realizó ningún cobro definitivo")

        case .reversed:
            return (coral, "arrow.uturn.backward", "Operación reversada", "El saldo fue reintegrado a tu cuenta")
        }
    }

    private var counterpartyLabel: String {
        switch transaction.type {
        case .transfer:
            return isIncoming ? "Enviado por" : "Destinatario"
        case .deposit:
            return "Origen"
        case .conversion:
            return "Conversión"
        case .cardPocket, .cardPurchase:
            return "Concepto"
        case .savings:
            return "Bolsillo"
        case .loan:
            return "Concepto"
        case .unknown:
            return "Detalle"
        }
    }

    private var networkTitle: String {
        switch transaction.type {
        case .cardPocket: return "CuyPay · Bolsillo Tarjeta"
        case .cardPurchase: return "Red Visa · Tarjeta CuyPay"
        case .conversion: return "CuyPay · Conversión FX"
        case .savings: return "CuyPay · Bolsillo de Ahorro"
        case .loan: return "CuyPay · Créditos"
        default: return "ACH Colombia · Bre-B"
        }
    }

    private var cleanSenderName: String? {
        guard let raw = senderName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              raw.lowercased() != "usuario cuypay"
        else { return nil }
        return raw.uppercased()
    }

    private var formattedDate: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "es_CO")
        formatter.dateFormat = "d 'de' MMM yyyy · h:mm a"
        return formatter.string(from: transaction.createdAt)
    }

    var body: some View {
        VStack(spacing: 0) {
            // MARK: Zona superior (Marca + Estado + Monto)
            VStack(spacing: 16) {
                HStack(alignment: .center) {
                    CuyPayLogo(
                        size: 16,
                        color: .white,
                        markColor: Color(red: 0.36, green: 0.87, blue: 0.78)
                    )
                    Spacer()
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 9.5, weight: .bold))
                        Text("COMPROBANTE")
                            .font(.system(size: 9.5, weight: .bold, design: .rounded))
                            .tracking(1.0)
                    }
                    .foregroundStyle(.white.opacity(0.78))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4.5)
                    .background(.white.opacity(0.09), in: Capsule())
                }

                // Medallón de estado refinado
                VStack(spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(statusPalette.color.opacity(0.14))
                            .frame(width: 58, height: 58)
                        Circle()
                            .strokeBorder(statusPalette.color.opacity(0.45), lineWidth: 1.2)
                            .frame(width: 58, height: 58)
                        Circle()
                            .fill(statusPalette.color)
                            .frame(width: 38, height: 38)
                        Image(systemName: statusPalette.icon)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(Color(red: 0.04, green: 0.10, blue: 0.11))
                    }

                    VStack(spacing: 3) {
                        Text(verbatim: statusPalette.headline)
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)

                        if let subheadline = statusPalette.subheadline {
                            Text(verbatim: subheadline)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(.white.opacity(0.62))
                                .multilineTextAlignment(.center)
                        }
                    }
                }
                .padding(.top, 2)

                // Monto principal
                VStack(spacing: 5) {
                    Text(transaction.type == .conversion ? "MONTO RECIBIDO" : "VALOR DE LA OPERACIÓN")
                        .font(.system(size: 9.5, weight: .bold))
                        .tracking(1.2)
                        .foregroundStyle(.white.opacity(0.50))

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: displayedAmount.formatted())
                            .font(.system(size: 36, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)

                        Text(verbatim: displayedAmount.currency.code)
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .foregroundStyle(Color(red: 0.56, green: 0.89, blue: 0.83))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.white.opacity(0.09), in: Capsule())
                    }

                    if let conv = transaction.conversion {
                        Text(verbatim: "Convertido desde \(conv.fromAmount.formatted())")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.white.opacity(0.62))
                    }
                }
                .padding(.bottom, 2)
            }
            .padding(.horizontal, 22)
            .padding(.top, 22)
            .padding(.bottom, 18)

            // MARK: Divisor perforado tipo ticket bancario
            ticketPerforationDivider

            // MARK: Zona inferior (Campos estructurados)
            VStack(spacing: 13) {
                voucherRow(
                    label: counterpartyLabel,
                    primary: transaction.title,
                    secondary: transaction.subtitle
                )

                if let sender = cleanSenderName, !isIncoming && transaction.type == .transfer {
                    subtleLine
                    voucherRow(
                        label: "Enviado desde",
                        primary: sender,
                        secondary: "Cuenta CuyPay COP"
                    )
                }

                if let conv = transaction.conversion {
                    subtleLine
                    voucherRow(
                        label: "Tasa aplicada",
                        primary: RateFormatter.headline(rate: conv.rate),
                        secondary: nil
                    )
                }

                subtleLine

                voucherRow(
                    label: "Red de pago",
                    primary: networkTitle,
                    secondary: nil
                )

                subtleLine

                HStack(alignment: .center) {
                    Text("Costo de envío")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.58))
                    Spacer()
                    if transaction.feeMinor == 0 {
                        Text("$ 0 · Sin costo")
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                            .foregroundStyle(Color(red: 0.36, green: 0.90, blue: 0.78))
                    } else {
                        Text(verbatim: transaction.fee.formatted())
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                    }
                }

                subtleLine

                voucherRow(
                    label: "Fecha y hora",
                    primary: formattedDate,
                    secondary: nil
                )

                subtleLine

                // Referencia bancaria
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Referencia")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.white.opacity(0.56))
                        Spacer()
                        if !isExporting, let onCopyReference {
                            Button(action: onCopyReference) {
                                HStack(spacing: 4) {
                                    Image(systemName: copiedReference ? "checkmark" : "doc.on.doc")
                                        .font(.system(size: 10, weight: .bold))
                                    Text(copiedReference ? "Copiada" : "Copiar")
                                        .font(.system(size: 11, weight: .semibold))
                                }
                                .foregroundStyle(copiedReference ? Color(red: 0.36, green: 0.90, blue: 0.78) : Color(red: 0.56, green: 0.89, blue: 0.83))
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Text(verbatim: transaction.id)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.90))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 8)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                // Sello inferior de autenticidad
                HStack(spacing: 6) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(Color(red: 0.36, green: 0.87, blue: 0.78))
                    Text("Operación protegida y verificada por CuyPay")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.52))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 4)
                    Text(verbatim: "cuypay.com")
                        .font(.system(size: 10.5, weight: .bold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.62))
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 22)
            .padding(.top, 16)
            .padding(.bottom, 20)
        }
        .background(voucherSurfaceBackground)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [.white.opacity(0.22), .white.opacity(0.06), Color(red: 0.20, green: 0.62, blue: 0.56).opacity(0.28)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .shadow(color: .black.opacity(isExporting ? 0.35 : 0.24), radius: 18, y: 8)
    }

    // MARK: Subcomponentes del ticket

    private var voucherSurfaceBackground: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.065, green: 0.135, blue: 0.155),
                    Color(red: 0.048, green: 0.095, blue: 0.112),
                    Color(red: 0.038, green: 0.072, blue: 0.086)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            RadialGradient(
                colors: [
                    Theme.spruceSolid.opacity(0.32),
                    .clear
                ],
                center: .top,
                startRadius: 10,
                endRadius: 220
            )
        }
    }

    private var ticketPerforationDivider: some View {
        let notchColor = Color(red: 0.036, green: 0.072, blue: 0.084)
        return ZStack {
            VoucherDashedLine()
                .stroke(.white.opacity(0.18), style: StrokeStyle(lineWidth: 1.1, dash: [5, 5]))
                .frame(height: 1.2)
                .padding(.horizontal, 18)

            HStack {
                Circle()
                    .fill(notchColor)
                    .frame(width: 20, height: 20)
                    .overlay(Circle().strokeBorder(.white.opacity(0.14), lineWidth: 1))
                    .offset(x: -10)
                Spacer()
                Circle()
                    .fill(notchColor)
                    .frame(width: 20, height: 20)
                    .overlay(Circle().strokeBorder(.white.opacity(0.14), lineWidth: 1))
                    .offset(x: 10)
            }
        }
        .frame(height: 20)
        .clipped()
    }

    private var subtleLine: some View {
        Rectangle()
            .fill(.white.opacity(0.07))
            .frame(height: 1)
    }

    private func voucherRow(label: String, primary: String, secondary: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(verbatim: label)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.58))

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: primary)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.trailing)

                if let secondary, !secondary.isEmpty {
                    Text(verbatim: secondary)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.65))
                        .multilineTextAlignment(.trailing)
                }
            }
        }
    }
}

private struct VoucherDashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return p
    }
}

// MARK: - Certificado Visual de Bolsillo de Ahorro para Compartir (@3x)

struct CuyPaySavingsCertificateExportCard: View {
    let block: SavingsBlock
    let holderName: String?

    private var formattedStart: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "es_CO")
        f.dateFormat = "d 'de' MMM yyyy · h:mm a"
        return f.string(from: block.startedAt)
    }

    private var formattedMaturity: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "es_CO")
        f.dateFormat = "d 'de' MMM yyyy · h:mm a"
        return f.string(from: block.maturesAt)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                CuyPayLogo(size: 16, color: .white, markColor: Color(red: 0.36, green: 0.87, blue: 0.78))
                Spacer()
                Text("CERTIFICADO DE AHORRO")
                    .font(.system(size: 9.5, weight: .bold, design: .rounded))
                    .tracking(1.0)
                    .foregroundStyle(.white.opacity(0.82))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4.5)
                    .background(.white.opacity(0.10), in: Capsule())
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("CAPITAL BLOQUEADO")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.1)
                    .foregroundStyle(.white.opacity(0.55))
                Text(verbatim: block.principal.formatted())
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                Text(verbatim: "Plazo \(block.termDays) días · \(String(format: "%.2f", block.lockedRate))% E.A. garantizado")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(Color(red: 0.42, green: 0.92, blue: 0.80))
            }

            Rectangle().fill(.white.opacity(0.10)).frame(height: 1)

            VStack(spacing: 10) {
                if let holderName, !holderName.isEmpty {
                    certRow("Titular", holderName.uppercased())
                }
                certRow("Interés proyectado", "+" + block.expectedYield.formatted())
                certRow("Total al vencimiento", block.totalPayout.formatted())
                certRow("Constitución", formattedStart)
                certRow("Reintegro automático", formattedMaturity)
                certRow("Estado", block.status.title)
                certRow("ID Certificado", block.id)
            }

            Rectangle().fill(.white.opacity(0.10)).frame(height: 1)

            HStack {
                Label("Respaldado por XATECH SERVICES S.A.S.", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white.opacity(0.58))
                Spacer()
                Text(verbatim: "cuypay.com")
                    .font(.system(size: 10.5, weight: .bold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.68))
            }
        }
        .padding(22)
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.05, green: 0.16, blue: 0.15),
                    Color(red: 0.04, green: 0.09, blue: 0.11)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(.white.opacity(0.18), lineWidth: 1)
        )
    }

    private func certRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(verbatim: label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.58))
            Spacer()
            Text(verbatim: value)
                .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
    }
}

// MARK: - Renderizador PNG @3x y Presentador Nativo de Comprobante (WhatsApp / Fotos / Correo)

@MainActor
enum VoucherSharePresenter {
    /// Renderiza el comprobante oficial sobre un lienzo opaco de marca a escala `@3x` (1170 px de ancho)
    /// y abre la hoja nativa de iOS con la imagen PNG lista para enviar como imagen en WhatsApp.
    static func shareTransactionVoucher(
        _ transaction: WalletTransaction,
        pocket: Currency? = nil,
        senderName: String? = nil
    ) {
        let poster = CuyPayVoucherCard(
            transaction: transaction,
            pocket: pocket,
            senderName: senderName,
            isExporting: true
        )
        .padding(22)
        .background(exportCanvasBackground)

        let title = "Comprobante CuyPay · \(transaction.amount.formatted())"
        renderAndPresent(view: poster, width: 390, title: title)
    }

    static func shareSavingsCertificate(block: SavingsBlock, holderName: String?) {
        let poster = CuyPaySavingsCertificateExportCard(block: block, holderName: holderName)
            .padding(22)
            .background(exportCanvasBackground)

        let title = "Certificado de Ahorro CuyPay · \(block.principal.formatted())"
        renderAndPresent(view: poster, width: 390, title: title)
    }

    private static var exportCanvasBackground: some View {
        LinearGradient(
            colors: [
                Color(red: 0.036, green: 0.082, blue: 0.096),
                Color(red: 0.055, green: 0.135, blue: 0.145),
                Color(red: 0.030, green: 0.062, blue: 0.074)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// Genera el `UIImage` PNG `@3x` del comprobante para compartir o verificar en tests.
    static func renderVoucherImage(
        for transaction: WalletTransaction,
        pocket: Currency? = nil,
        senderName: String? = nil
    ) -> UIImage? {
        let poster = CuyPayVoucherCard(
            transaction: transaction,
            pocket: pocket,
            senderName: senderName,
            isExporting: true
        )
        .padding(22)
        .background(exportCanvasBackground)
        .frame(width: 390)
        .fixedSize(horizontal: false, vertical: true)
        .environment(\.colorScheme, .dark)

        let renderer = ImageRenderer(content: poster)
        renderer.scale = 3.0
        renderer.isOpaque = true
        guard let rawImage = renderer.uiImage else { return nil }
        if let png = rawImage.pngData(), let decoded = UIImage(data: png) {
            return decoded
        }
        return rawImage
    }

    private static func renderAndPresent<V: View>(view: V, width: CGFloat, title: String) {
        let framed = view
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.colorScheme, .dark)

        let renderer = ImageRenderer(content: framed)
        renderer.scale = 3.0
        renderer.isOpaque = true

        guard let rawImage = renderer.uiImage else { return }
        let cleanImage: UIImage
        if let png = rawImage.pngData(), let decoded = UIImage(data: png) {
            cleanImage = decoded
        } else {
            cleanImage = rawImage
        }

        UIImpactFeedbackGenerator(style: .light).impactOccurred()

        let itemSource = VoucherActivityItemSource(image: cleanImage, title: title)
        let activityVC = UIActivityViewController(activityItems: [itemSource], applicationActivities: nil)

        guard let windowScene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let keyWindow = windowScene.windows.first(where: \.isKeyWindow) ?? windowScene.windows.first,
              var topController = keyWindow.rootViewController
        else { return }

        while let presented = topController.presentedViewController {
            topController = presented
        }

        if let popover = activityVC.popoverPresentationController {
            popover.sourceView = topController.view
            popover.sourceRect = CGRect(
                x: topController.view.bounds.midX,
                y: topController.view.bounds.maxY - 80,
                width: 1,
                height: 1
            )
            popover.permittedArrowDirections = []
        }

        topController.present(activityVC, animated: true)
    }
}

private final class VoucherActivityItemSource: NSObject, UIActivityItemSource, @unchecked Sendable {
    private let image: UIImage
    private let title: String

    init(image: UIImage, title: String) {
        self.image = image
        self.title = title
        super.init()
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        image
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
        image
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        dataTypeIdentifierForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        "public.png"
    }

    func activityViewController(
        _ activityViewController: UIActivityViewController,
        subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String {
        title
    }

    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = title
        metadata.imageProvider = NSItemProvider(object: image)
        metadata.iconProvider = NSItemProvider(object: image)
        return metadata
    }
}
