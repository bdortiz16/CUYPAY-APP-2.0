import SwiftUI
import PassKit
import UIKit

/// Vista rediseñada de Tarjeta CuyPay (Visa virtual en COP con bolsillo dedicado recargable desde Bre-B).
/// Integra tarjeta virtual premium, bolsillo independiente sin costo, datos copiables en línea,
/// movimientos de tarjeta y vinculación con Apple Wallet sin exponer marcas de terceros.
struct CardView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(AppModel.hideAmountsKey) private var hideAmounts = false

    private enum ContactFollowUpAction {
        case issueCard
        case replaceCard
    }

    @State private var isIssuing = false
    @State private var isCanceling = false
    @State private var isTogglingState = false
    @State private var isLoadingSecrets = false
    @State private var showSecrets = false
    @State private var cardSecrets: CardSensitiveDetails?
    @State private var copiedField: String?
    @State private var pocketTransferMode: CardPocketTransferMode?
    @State private var pocketFeedbackMessage: String?
    @State private var selectedTransaction: WalletTransaction?
    @State private var showRename = false
    @State private var newLabel = ""
    @State private var showCancelConfirm = false
    @State private var showAppleWalletSheet = false
    @State private var showApplePaySuccess = false
    @State private var showEditContactSheet = false
    @State private var contactFollowUpAction: ContactFollowUpAction?
    @State private var walletCoordinator: AppleWalletProvisioningCoordinator?
    @State private var errorMessage: String?

    private var activeCard: CardItem? {
        store.activeCard
    }

    private var holderName: String {
        let verifiedHolder = activeCard?.holderName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !verifiedHolder.isEmpty, verifiedHolder.lowercased() != "usuario cuypay" {
            return verifiedHolder.uppercased()
        }
        if let user = app.user, !user.hasPlaceholderName {
            let name = user.fullName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return name.uppercased() }
        }
        return verifiedHolder.isEmpty ? "TITULAR CUYPAY" : verifiedHolder.uppercased()
    }

    private var verificationEmailSummary: String {
        guard let user = app.user, !user.hasPlaceholderEmail else {
            return String(localized: "Sin correo configurado")
        }
        return user.email
    }

    private var needsCardContactReplacement: Bool {
        if app.user?.hasPlaceholderContact == true {
            return true
        }
        let cardHolder = activeCard?.holderName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return cardHolder == "usuario cuypay"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                ScrollView {
                    if let card = activeCard, store.cardsLoaded {
                        VStack(alignment: .leading, spacing: 18) {
                            virtualCardShowcase(card)
                                .padding(.top, 6)

                            if let pocketFeedbackMessage {
                                pocketSuccessBanner(pocketFeedbackMessage)
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }

                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            cardPocketHero(card)

                            quickActionsBar(card)

                            if needsCardContactReplacement {
                                placeholderContactBanner
                            }

                            cardDataSection(card)

                            if !store.cardTransactions.isEmpty {
                                cardMovementsSection
                            }

                            cardSettingsSection(card)
                        }
                        .padding(.horizontal, 18)
                        .padding(.bottom, 36)
                    } else {
                        VStack(spacing: 22) {
                            if !store.cardsLoaded {
                                ProgressView("Cargando tu tarjeta…")
                                    .padding(.top, 80)
                            } else if !app.isKYCApproved {
                                kycRequiredView
                            } else {
                                emptyCardView
                            }

                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.bottom, 30)
                    }
                }
                .scrollIndicators(.hidden)
                .refreshable {
                    async let u: Void = app.refreshUser()
                    async let w: Void = store.refreshWallets()
                    async let c: Void = store.refreshCards()
                    async let t: Void = store.refreshTransactions()
                    _ = await (u, w, c, t)
                }
            }
            .navigationTitle(activeCard != nil ? "Mi Tarjeta" : "Tarjeta CuyPay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                async let u: Void = app.refreshUser()
                async let w: Void = store.refreshWallets()
                async let c: Void = store.refreshCards()
                _ = await (u, w, c)
            }
            .onDisappear {
                showSecrets = false
                cardSecrets = nil
            }
            .sheet(item: $pocketTransferMode) { transferMode in
                if let card = activeCard {
                    CardPocketTransferSheet(card: card, initialMode: transferMode) { res in
                        let moved = Money(minorUnits: res.transaction.amountMinor, currency: .cop).formatted()
                        let message = transferMode == .fund
                            ? "Recargaste \(moved) al bolsillo de tu tarjeta"
                            : "Pasaste \(moved) a tu saldo principal Bre-B"
                        showPocketToast(message)
                    }
                }
            }
            .sheet(item: $selectedTransaction) { txn in
                TransactionDetailSheet(transaction: txn, pocket: .cop)
            }
            .sheet(isPresented: $showRename) {
                renameSheet
            }
            .sheet(isPresented: $showAppleWalletSheet) {
                if let card = activeCard {
                    appleWalletSheet(card)
                }
            }
            .sheet(isPresented: $showEditContactSheet) {
                EditContactProfileSheet(
                    subtitle: contactFollowUpAction == .replaceCard
                        ? String(localized: "Ingresa tu nombre, correo y celular reales. Al guardar, reemplazaremos tu tarjeta anterior por una nueva vinculada a estos datos para recibir los códigos de Apple Wallet.")
                        : String(localized: "Confirma el correo y el celular donde recibirás los códigos de verificación de tu tarjeta virtual y Apple Wallet."),
                    saveButtonTitle: contactFollowUpAction == .replaceCard
                        ? "Guardar y reemplazar tarjeta"
                        : (contactFollowUpAction == .issueCard ? "Guardar y crear tarjeta" : "Guardar datos")
                ) { _ in
                    let followUp = contactFollowUpAction
                    contactFollowUpAction = nil
                    if followUp == .replaceCard {
                        Task { await performCancelAndReissueAfterContactReady() }
                    } else if followUp == .issueCard {
                        Task { await issueCard() }
                    }
                }
            }
            .confirmationDialog(
                "¿Eliminar o reemplazar tu tarjeta?",
                isPresented: $showCancelConfirm,
                titleVisibility: .visible
            ) {
                Button("Eliminar y crear nueva tarjeta", role: .destructive) {
                    Task { await cancelAndReissueCard() }
                }
                Button("Solo eliminar tarjeta", role: .destructive) {
                    Task { await cancelCard(preservePocket: false) }
                }
                Button("Volver", role: .cancel) {}
            } message: {
                Text("Si reemplazas tu tarjeta, el saldo de tu bolsillo se conserva automáticamente en la nueva. Si solo la eliminas, tu saldo disponible regresa sin costo a tu cuenta principal Bre-B.")
            }
            .alert("Apple Wallet", isPresented: $showApplePaySuccess) {
                Button("Listo") {}
            } message: {
                Text("Tu tarjeta CuyPay quedó vinculada exitosamente a Apple Wallet.")
            }
        }
    }

    // MARK: - 1. Tarjeta Virtual CuyPay (Showcase metálico)

    private func virtualCardShowcase(_ card: CardItem) -> some View {
        let isFrozen = card.status == .frozen

        return ZStack {
            LinearGradient(
                colors: isFrozen
                    ? [Theme.onyx.opacity(0.92), Theme.jetBlack.opacity(0.82), Color(white: 0.25)]
                    : [Theme.onyx, Theme.jetBlack, Theme.spruceSolid],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            // Brillo especular sutil de esquina superior derecha
            RadialGradient(
                colors: [
                    (isFrozen ? Color.white : Theme.slate).opacity(0.24),
                    Color.clear
                ],
                center: .topTrailing,
                startRadius: 12,
                endRadius: 210
            )

            // Trazo decorativo diagonal sutil
            Circle()
                .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                .frame(width: 260, height: 260)
                .offset(x: 115, y: -75)

            VStack(alignment: .leading, spacing: 0) {
                // Cabecera: Marca + estado + sin contacto
                HStack(alignment: .center, spacing: 10) {
                    CuyPayLogo(size: 16, color: .white, markColor: Theme.slate)

                    Spacer()

                    HStack(spacing: 5) {
                        Circle()
                            .fill(isFrozen ? Theme.warning : Theme.positive)
                            .frame(width: 6, height: 6)
                        Text(isFrozen ? "Bloqueada" : "Activa")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.92))
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Color.white.opacity(0.12), in: .capsule)

                    Image(systemName: "wave.3.forward")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.82))
                }

                Spacer(minLength: 14)

                // Chip virtual + número de tarjeta
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 5)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.36),
                                    Theme.slate.opacity(0.25)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 34, height: 24)
                        .overlay {
                            RoundedRectangle(cornerRadius: 5)
                                .strokeBorder(Color.white.opacity(0.35), lineWidth: 0.7)
                        }

                    Text(verbatim: displayedPan(for: card))
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .contentTransition(.numericText())
                }

                Spacer(minLength: 14)

                // Pie: Titular + etiqueta + franquicia
                HStack(alignment: .bottom, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: card.label.uppercased())
                            .font(.system(size: 9.5, weight: .semibold))
                            .tracking(0.8)
                            .foregroundStyle(Theme.slate.opacity(0.9))
                        Text(verbatim: holderName)
                            .font(.system(size: 13.5, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }

                    Spacer(minLength: 8)

                    VStack(alignment: .trailing, spacing: 2) {
                        cardBrandHeroMark(for: card.brand)
                        Text("Débito COP")
                            .font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                }
            }
            .padding(22)
        }
        .frame(height: 204)
        .clipShape(.rect(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24)
                .strokeBorder(
                    LinearGradient(
                        colors: [.white.opacity(0.28), .white.opacity(0.06)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.38 : 0.16), radius: 18, x: 0, y: 10)
    }

    // MARK: - 2. Bolsillo de la tarjeta (Recarga desde Bre-B y retiro a principal)

    private func cardPocketHero(_ card: CardItem) -> some View {
        let pocket = card.pocketBalance
        let mainCop = store.copMainAvailable
        let canWithdraw = pocket.minorUnits >= 10_000

        return VStack(alignment: .leading, spacing: 16) {
            // Fila superior: Título del bolsillo + badge $0 + ocultar saldo
            HStack(alignment: .center, spacing: 8) {
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(Theme.spruce.opacity(0.15))
                            .frame(width: 30, height: 30)
                        Image(systemName: "wallet.bifold.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.spruce)
                    }

                    Text("Bolsillo de tu tarjeta")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                        .foregroundStyle(.primary)
                }

                Spacer()

                Text("$ 0 costo")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.spruce)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Theme.spruce.opacity(0.12), in: .capsule)

                Button {
                    withAnimation(.snappy) { hideAmounts.toggle() }
                } label: {
                    Image(systemName: hideAmounts ? "eye.slash" : "eye")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hideAmounts ? Text("Mostrar saldo de tarjeta") : Text("Ocultar saldo de tarjeta"))
            }

            // Monto disponible para compras
            VStack(alignment: .leading, spacing: 4) {
                pocketAmountText(pocket)

                Text(pocket.minorUnits > 0
                     ? "Disponible para pagar con tu tarjeta virtual"
                     : "Recarga este bolsillo con tu saldo Bre-B para comprar")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Indicador conectado al saldo principal Bre-B
            HStack(spacing: 8) {
                Text(verbatim: "🇨🇴")
                    .font(.footnote)
                Text("Saldo principal Bre-B:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(verbatim: hideAmounts ? mainCop.maskedString : mainCop.formatted())
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
                Color.primary.opacity(colorScheme == .dark ? 0.07 : 0.045),
                in: .rect(cornerRadius: 12)
            )

            // Botones principales de acción del bolsillo
            HStack(spacing: 10) {
                Button {
                    pocketTransferMode = .fund
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus.circle.fill")
                            .font(.subheadline.weight(.semibold))
                        Text("Recargar")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                    .background(Theme.spruceSolid, in: .capsule)
                }
                .buttonStyle(.plain)
                .disabled(card.status == .canceled)
                .opacity(card.status == .canceled ? 0.45 : 1)

                Button {
                    pocketTransferMode = .withdraw
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "arrow.uturn.backward.circle")
                            .font(.subheadline.weight(.semibold))
                        Text("A principal")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                    .background(
                        Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.07),
                        in: .capsule
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canWithdraw)
                .opacity(canWithdraw ? 1 : 0.42)
            }
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24)
                .strokeBorder(Theme.spruce.opacity(colorScheme == .dark ? 0.25 : 0.15), lineWidth: 1)
        }
    }

    @ViewBuilder
    private func pocketAmountText(_ amount: Money) -> some View {
        if hideAmounts {
            Text(verbatim: amount.maskedString)
                .font(.system(size: 36, weight: .regular, design: .serif))
                .foregroundStyle(.primary)
        } else {
            let showFraction = amount.fractionMagnitude != 0
            let fraction = amount.fractionMagnitude
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(verbatim: amount.formatted(includeSymbol: true).components(separatedBy: ",").first ?? "")
                    .foregroundStyle(.primary)
                if showFraction {
                    Text(verbatim: "," + (fraction < 10 ? "0\(fraction)" : "\(fraction)"))
                        .foregroundStyle(.tertiary)
                }
                Text(verbatim: " COP")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .font(.system(size: 36, weight: .regular, design: .serif))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.55)
            .contentTransition(.numericText())
        }
    }

    private func pocketSuccessBanner(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Theme.positive)
            Text(verbatim: text)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .glassEffect(.regular.tint(Theme.positive.opacity(0.14)), in: .rect(cornerRadius: 16))
    }

    private func showPocketToast(_ message: String) {
        withAnimation(.snappy) {
            pocketFeedbackMessage = message
        }
        Task {
            try? await Task.sleep(for: .seconds(3.5))
            if pocketFeedbackMessage == message {
                withAnimation(.easeOut(duration: 0.25)) {
                    pocketFeedbackMessage = nil
                }
            }
        }
    }

    // MARK: - 3. Barra de controles rápidos (3 botones)

    private func quickActionsBar(_ card: CardItem) -> some View {
        HStack(spacing: 10) {
            quickActionTile(
                title: showSecrets ? "Ocultar datos" : "Ver datos",
                systemImage: showSecrets ? "eye.slash" : "eye",
                isLoading: isLoadingSecrets,
                tint: Theme.spruce,
                disabled: card.status == .canceled || isLoadingSecrets
            ) {
                Task { await toggleCardSecrets(card) }
            }

            quickActionTile(
                title: card.status == .frozen ? "Desbloquear" : "Bloquear",
                systemImage: card.status == .frozen ? "lock.open.fill" : "lock",
                isLoading: isTogglingState,
                tint: card.status == .frozen ? Theme.warning : .primary,
                disabled: card.status == .canceled || isTogglingState
            ) {
                Task { await toggleFreeze(card) }
            }

            quickActionTile(
                title: "Apple Wallet",
                systemImage: "wallet.pass",
                isLoading: false,
                tint: .primary,
                disabled: card.status != .active
            ) {
                Task { await startAppleWalletFlow(card) }
            }
        }
    }

    private func quickActionTile(
        title: LocalizedStringKey,
        systemImage: String,
        isLoading: Bool,
        tint: Color,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                ZStack {
                    Circle()
                        .fill(tint.opacity(0.12))
                        .frame(width: 38, height: 38)

                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: systemImage)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(tint)
                    }
                }

                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity)
            .contentShape(.rect(cornerRadius: 20))
            .opacity(disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
    }

    // MARK: - 4. Tabla en línea "Datos de la tarjeta"

    private func cardDataSection(_ card: CardItem) -> some View {
        let borderColor = Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.08)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                Text("Datos de la tarjeta")
                    .font(.system(.subheadline, design: .serif).weight(.semibold))
                    .foregroundStyle(.primary)

                Spacer()

                Button {
                    Task { await toggleCardSecrets(card) }
                } label: {
                    HStack(spacing: 5) {
                        if isLoadingSecrets {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: showSecrets ? "eye.slash" : "eye")
                                .font(.caption.weight(.semibold))
                        }
                        Text(showSecrets ? "Ocultar" : "Mostrar CVV y número")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Theme.spruce)
                }
                .buttonStyle(.plain)
                .disabled(card.status == .canceled || isLoadingSecrets)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                // Fila 1: Nombre del titular
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nombre del titular")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(verbatim: holderName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                    copyButton(value: holderName, id: "holder")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 2: Número de la tarjeta (PAN real o enmascarado)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Número de tarjeta")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(verbatim: displayedPan(for: card))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                    if showSecrets, let secrets = cardSecrets {
                        copyButton(value: secrets.rawPan, id: "pan")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 3: Válida hasta | CVC
                HStack(spacing: 0) {
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Válida hasta")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(verbatim: showSecrets ? (cardSecrets?.expiry ?? "••/••") : "••/••")
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(.primary)
                        }
                        Spacer(minLength: 4)
                        if showSecrets, let secrets = cardSecrets {
                            copyButton(value: secrets.expiry, id: "exp")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Rectangle()
                        .fill(borderColor)
                        .frame(width: 1)

                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("CVC")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(verbatim: showSecrets ? (cardSecrets?.cvv ?? "•••") : "•••")
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(.primary)
                        }
                        Spacer(minLength: 4)
                        if showSecrets, let secrets = cardSecrets {
                            copyButton(value: secrets.cvv, id: "cvv")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 4: Función | Franquicia (Visa / Mastercard)
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Modalidad")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Débito recargable")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Rectangle()
                        .fill(borderColor)
                        .frame(width: 1)

                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Red")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(verbatim: "\(card.brand) Internacional")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        Spacer(minLength: 4)
                        tableBrandMark(for: card.brand)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
        }
    }

    // MARK: - 5. Movimientos recientes de la tarjeta

    private var cardMovementsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Movimientos de tu tarjeta")
                .font(.system(.subheadline, design: .serif).weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 4)

            VStack(spacing: 4) {
                ForEach(Array(store.cardTransactions.prefix(4))) { txn in
                    Button {
                        selectedTransaction = txn
                    } label: {
                        TransactionRow(transaction: txn, pocket: .cop, hideAmounts: hideAmounts)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
        }
    }

    // MARK: - Helpers de formato y marca

    private func copyButton(value: String, id: String) -> some View {
        let isCopied = copiedField == id
        return Button {
            copyToPasteboard(value, id: id)
        } label: {
            Image(systemName: isCopied ? "checkmark.circle.fill" : "doc.on.doc")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isCopied ? Theme.positive : Theme.spruce)
                .frame(width: 32, height: 32)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Copiar"))
    }

    private func copyToPasteboard(_ value: String, id: String) {
        UIPasteboard.general.string = value
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.easeInOut(duration: 0.18)) {
            copiedField = id
        }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            if copiedField == id {
                withAnimation(.easeInOut(duration: 0.18)) {
                    copiedField = nil
                }
            }
        }
    }

    private func effectiveLastFour(for card: CardItem) -> String {
        if let secrets = cardSecrets, secrets.rawPan.count >= 4 {
            return String(secrets.rawPan.suffix(4))
        }
        if card.lastFour.count == 4 && card.lastFour != "0000" {
            return card.lastFour
        }
        return ""
    }

    private func displayedPan(for card: CardItem) -> String {
        if showSecrets, let secrets = cardSecrets {
            return secrets.formattedPan
        }
        let suffix = effectiveLastFour(for: card)
        return suffix.isEmpty ? "••••  ••••  ••••  ••••" : "••••  ••••  ••••  \(suffix)"
    }

    @ViewBuilder
    private func cardBrandHeroMark(for brand: String) -> some View {
        if brand.lowercased().contains("master") {
            HStack(spacing: -6) {
                Circle().fill(Color(red: 0.92, green: 0.0, blue: 0.11)).frame(width: 20, height: 20)
                Circle().fill(Color(red: 0.97, green: 0.62, blue: 0.11).opacity(0.92)).frame(width: 20, height: 20)
            }
        } else {
            Text(verbatim: "VISA")
                .font(.system(size: 19, weight: .black, design: .rounded))
                .italic()
                .foregroundStyle(.white)
        }
    }

    @ViewBuilder
    private func tableBrandMark(for brand: String) -> some View {
        if brand.lowercased().contains("master") {
            HStack(spacing: -8) {
                Circle().fill(Color(red: 0.92, green: 0.0, blue: 0.11)).frame(width: 22, height: 22)
                Circle().fill(Color(red: 0.97, green: 0.62, blue: 0.11).opacity(0.92)).frame(width: 22, height: 22)
            }
        } else {
            Text(verbatim: "VISA")
                .font(.system(size: 15, weight: .black, design: .rounded))
                .italic()
                .foregroundStyle(colorScheme == .dark ? Color.white : Color(red: 0.08, green: 0.20, blue: 0.62))
        }
    }

    // MARK: - Aviso de datos de contacto para códigos Apple Wallet

    private var placeholderContactBanner: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Actualiza tu correo para recibir códigos")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.primary)
                    Text("Esta tarjeta fue creada sin tu correo real. Actualiza tu correo y celular, y reemplázala gratis conservando el saldo de tu bolsillo.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Button {
                contactFollowUpAction = .replaceCard
                showEditContactSheet = true
            } label: {
                HStack(spacing: 8) {
                    if isCanceling || isIssuing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    Text("Actualizar correo y reemplazar tarjeta")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Theme.spruceSolid, in: .rect(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(isCanceling || isIssuing)
        }
        .padding(16)
        .background(Theme.warning.opacity(colorScheme == .dark ? 0.14 : 0.10), in: .rect(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Theme.warning.opacity(0.35), lineWidth: 1)
        }
    }

    // MARK: - 6. Sección "Configurar tarjeta"

    private func cardSettingsSection(_ card: CardItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Configurar tarjeta")
                .font(.system(.subheadline, design: .serif).weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                settingsRow(
                    icon: "wallet.pass",
                    iconColor: .primary,
                    title: "Agregar a Apple Wallet",
                    subtitle: "Vincula tu tarjeta virtual para pagar sin contacto con tu iPhone o Apple Watch.",
                    disabled: card.status != .active
                ) {
                    Task { await startAppleWalletFlow(card) }
                }

                Divider().padding(.leading, 54)

                settingsRow(
                    icon: "envelope.badge.shield.half.filled",
                    iconColor: needsCardContactReplacement ? Theme.warning : Theme.spruce,
                    title: "Correo y celular de códigos",
                    subtitle: "\(verificationEmailSummary) · \(app.user?.phone ?? "")",
                    disabled: isCanceling || isIssuing
                ) {
                    contactFollowUpAction = needsCardContactReplacement ? .replaceCard : nil
                    showEditContactSheet = true
                }

                Divider().padding(.leading, 54)

                settingsRow(
                    icon: "slider.horizontal.3",
                    iconColor: .primary,
                    title: "Personalizar tarjeta",
                    subtitle: "Etiqueta visible: \(card.label)",
                    disabled: card.status == .canceled
                ) {
                    newLabel = card.label
                    showRename = true
                }

                Divider().padding(.leading, 54)

                settingsRow(
                    icon: "trash",
                    iconColor: Theme.negative,
                    title: "Eliminar o reemplazar tarjeta",
                    subtitle: "Reemplázala conservando tu bolsillo o elimínala y devuelve el saldo a Bre-B.",
                    disabled: card.status == .canceled || isCanceling || isIssuing
                ) {
                    showCancelConfirm = true
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
        }
    }

    private func settingsRow(
        icon: String,
        iconColor: Color,
        title: LocalizedStringKey,
        subtitle: String,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(iconColor.opacity(0.11))
                        .frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(iconColor)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(verbatim: subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 12)
            .contentShape(.rect)
            .opacity(disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    // MARK: - Hoja guiada de Apple Wallet

    private func appleWalletSheet(_ card: CardItem) -> some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack(spacing: 14) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(Color.black)
                                    .frame(width: 52, height: 52)
                                Image(systemName: "wallet.pass.fill")
                                    .font(.title2)
                                    .foregroundStyle(.white)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Agregar a Apple Wallet")
                                    .font(.title3.weight(.bold))
                                Text("Usa tu tarjeta CuyPay desde tu iPhone")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 8)

                        Text("Copia los datos de tu tarjeta virtual y toca **Abrir Apple Wallet** para pegarlos directamente en la sección de tarjetas de tu iPhone.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Image(systemName: needsCardContactReplacement ? "exclamationmark.triangle.fill" : "envelope.badge.shield.half.filled")
                                    .foregroundStyle(needsCardContactReplacement ? Theme.warning : Theme.spruce)
                                Text(verbatim: "Códigos: \(verificationEmailSummary) · \(app.user?.phone ?? "")")
                                    .font(.footnote.weight(.semibold))
                            }
                            Button {
                                showAppleWalletSheet = false
                                Task {
                                    try? await Task.sleep(for: .milliseconds(250))
                                    contactFollowUpAction = .replaceCard
                                    showEditContactSheet = true
                                }
                            } label: {
                                Text("¿No te llega el código? Actualizar correo/celular y reemplazar tarjeta")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.spruce)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))

                        if isLoadingSecrets {
                            HStack(spacing: 12) {
                                ProgressView()
                                Text("Cargando datos seguros de tu tarjeta…")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 24)
                        } else if let secrets = cardSecrets {
                            VStack(spacing: 0) {
                                walletSecretRow(label: "Número de tarjeta", value: secrets.formattedPan, copyValue: secrets.rawPan, id: "w_pan")
                                Divider()
                                walletSecretRow(label: "Válida hasta", value: secrets.expiry, copyValue: secrets.expiry, id: "w_exp")
                                Divider()
                                walletSecretRow(label: "Código de seguridad (CVC)", value: secrets.cvv, copyValue: secrets.cvv, id: "w_cvv")
                            }
                            .glassEffect(.regular, in: .rect(cornerRadius: 18))

                            Button {
                                copyToPasteboard(secrets.rawPan, id: "w_pan")
                                AppleWalletProvisioningCoordinator.openAppleWalletSetup()
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "wallet.pass.fill")
                                        .font(.title3)
                                    Text("Copiar número y abrir Apple Wallet")
                                        .font(.headline)
                                }
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .frame(height: 54)
                                .background(Color.black, in: .capsule)
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        } else {
                            PrimaryButton(title: "Mostrar datos para Apple Wallet", systemImage: "faceid", isLoading: isLoadingSecrets) {
                                Task { await loadSecretsIfNeeded(card, authenticate: true) }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 28)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { showAppleWalletSheet = false }
                }
            }
        }
        .presentationDetents([.height(540), .large])
    }

    private func walletSecretRow(label: LocalizedStringKey, value: String, copyValue: String, id: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(verbatim: value)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }
            Spacer()
            copyButton(value: copyValue, id: id)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Estados vacíos

    private var emptyCardView: some View {
        VStack(spacing: 20) {
            ZStack {
                LinearGradient(
                    colors: [Theme.onyx, Theme.jetBlack, Theme.spruceSolid],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                RadialGradient(
                    colors: [Theme.slate.opacity(0.24), Color.clear],
                    center: .topTrailing,
                    startRadius: 10,
                    endRadius: 200
                )
                VStack(alignment: .leading) {
                    HStack {
                        CuyPayLogo(size: 16, color: .white, markColor: Theme.slate)
                        Spacer()
                        Text(verbatim: "VISA")
                            .font(.system(.subheadline, design: .rounded).weight(.heavy))
                            .italic()
                            .foregroundStyle(.white.opacity(0.92))
                    }
                    Spacer()
                    Text(verbatim: "••••  ••••  ••••  ••••")
                        .font(.system(.title3, design: .monospaced).weight(.semibold))
                        .foregroundStyle(.white.opacity(0.88))
                    Spacer()
                    HStack {
                        Text(verbatim: holderName)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.92))
                        Spacer()
                        Text("Bolsillo COP $ 0 costo")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.14), in: .capsule)
                    }
                }
                .padding(22)
            }
            .frame(height: 198)
            .clipShape(.rect(cornerRadius: 24))
            .shadow(color: .black.opacity(0.18), radius: 14, x: 0, y: 8)
            .padding(.top, 14)

            Text("Tu Tarjeta Virtual CuyPay")
                .font(.system(.title2, design: .serif).weight(.bold))
                .padding(.top, 2)

            Text("Compra en comercios nacionales e internacionales con un bolsillo independiente que recargas al instante y sin costo desde tu saldo Bre-B.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)

            VStack(alignment: .leading, spacing: 12) {
                emptyBenefitRow(icon: "wallet.bifold.fill", title: "Bolsillo protegido", detail: "Solo gastas lo que pases desde tu saldo principal Bre-B.")
                emptyBenefitRow(icon: "arrow.left.arrow.right", title: "Recarga y retiro gratis", detail: "Mueve plata hacia o desde tu tarjeta al instante con $ 0 comisión.")
                emptyBenefitRow(icon: "wallet.pass.fill", title: "Lista para Apple Wallet", detail: "Paga sin contacto desde tu iPhone y compra en línea.")
            }
            .padding(16)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))

            if let user = app.user {
                HStack(spacing: 10) {
                    Image(systemName: user.hasPlaceholderContact ? "exclamationmark.triangle.fill" : "envelope.badge.shield.half.filled")
                        .foregroundStyle(user.hasPlaceholderContact ? Theme.warning : Theme.spruce)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Códigos de Apple Wallet y compras")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(verbatim: "\(verificationEmailSummary) · \(user.phone)")
                            .font(.footnote.weight(.medium))
                    }
                    Spacer()
                    Button("Editar") {
                        contactFollowUpAction = nil
                        showEditContactSheet = true
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.spruce)
                }
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
            }

            PrimaryButton(title: "Crear mi tarjeta virtual", isLoading: isIssuing) {
                Task { await issueCard() }
            }
            .padding(.top, 4)
        }
    }

    private func emptyBenefitRow(icon: String, title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.spruce)
                .frame(width: 28, height: 28)
                .background(Theme.spruce.opacity(0.12), in: .circle)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var kycRequiredView: some View {
        ContentUnavailableView {
            Label("Verificación requerida", systemImage: "person.badge.shield.checkmark")
        } description: {
            Text("Para emitir tu tarjeta virtual CuyPay necesitas tener tu identidad verificada.")
        }
        .padding(.top, 40)
    }

    // MARK: - Hoja de renombrar

    private var renameSheet: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                VStack(spacing: 20) {
                    Text("Personalizar tarjeta")
                        .font(.system(.title3, design: .serif).weight(.semibold))
                        .padding(.top, 24)

                    TextField("Nombre de la tarjeta", text: $newLabel)
                        .formFieldStyle()

                    PrimaryButton(title: "Guardar", systemImage: "checkmark") {
                        Task {
                            if let card = activeCard {
                                do {
                                    _ = try await app.api.updateCardLabel(id: card.id, label: newLabel)
                                    await store.refreshCards()
                                    showRename = false
                                } catch {
                                    errorMessage = error.userMessage
                                }
                            }
                        }
                    }
                    .disabled(newLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Spacer()
                }
                .padding(.horizontal, 20)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { showRename = false }
                }
            }
        }
        .presentationDetents([.height(280)])
    }

    // MARK: - Acciones

    private func issueCard() async {
        if app.user?.hasPlaceholderContact == true {
            contactFollowUpAction = .issueCard
            showEditContactSheet = true
            return
        }
        isIssuing = true
        errorMessage = nil
        defer { isIssuing = false }
        do {
            _ = try await app.api.issueVirtualCard(label: "CuyPay Virtual")
            await store.refreshCards()
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func toggleCardSecrets(_ card: CardItem) async {
        if showSecrets {
            withAnimation(.easeInOut(duration: 0.2)) {
                showSecrets = false
            }
            return
        }
        await loadSecretsIfNeeded(card, authenticate: true)
    }

    private func loadSecretsIfNeeded(_ card: CardItem, authenticate: Bool) async {
        errorMessage = nil
        if let existing = cardSecrets {
            if authenticate {
                let authorized = await BiometricAuthenticator.authenticate(
                    reason: String(localized: "Autoriza ver los datos de tu tarjeta CuyPay")
                )
                guard authorized else { return }
            }
            withAnimation(.easeInOut(duration: 0.2)) {
                _ = existing
                showSecrets = true
            }
            return
        }

        if authenticate {
            let authorized = await BiometricAuthenticator.authenticate(
                reason: String(localized: "Autoriza ver los datos de tu tarjeta CuyPay")
            )
            guard authorized else { return }
        }

        isLoadingSecrets = true
        defer { isLoadingSecrets = false }

        do {
            let urlString = try await app.api.cardLookUrl(id: card.id)
            guard let url = URL(string: urlString) else {
                throw APIError.server(
                    status: 502,
                    code: .providerError,
                    message: "No se pudo abrir el canal seguro de datos de tu tarjeta.",
                    limit: nil
                )
            }
            let details = try await CardSecureDataExtractor.fetch(
                from: url,
                fallbackLastFour: card.lastFour
            )
            withAnimation(.easeInOut(duration: 0.2)) {
                cardSecrets = details
                showSecrets = true
            }
            if card.lastFour == "0000" {
                await store.refreshCards()
            }
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func toggleFreeze(_ card: CardItem) async {
        isTogglingState = true
        errorMessage = nil
        defer { isTogglingState = false }
        let newState = card.status == .frozen ? "active" : "frozen"
        do {
            _ = try await app.api.updateCardStatus(id: card.id, state: newState)
            await store.refreshCards()
        } catch {
            errorMessage = error.userMessage
        }
    }

    @discardableResult
    private func cancelCard(preservePocket: Bool) async -> Bool {
        guard let card = activeCard else { return false }
        isCanceling = true
        errorMessage = nil
        defer { isCanceling = false }
        do {
            _ = try await app.api.updateCardStatus(
                id: card.id,
                state: "canceled",
                preservePocket: preservePocket
            )
            cardSecrets = nil
            showSecrets = false
            async let w: Void = store.refreshWallets()
            async let c: Void = store.refreshCards()
            async let t: Void = store.refreshTransactions()
            _ = await (w, c, t)
            return true
        } catch {
            errorMessage = error.userMessage
            return false
        }
    }

    private func cancelAndReissueCard() async {
        if app.user?.hasPlaceholderContact == true {
            contactFollowUpAction = .replaceCard
            showEditContactSheet = true
            return
        }
        await performCancelAndReissueAfterContactReady()
    }

    private func performCancelAndReissueAfterContactReady() async {
        let canceled = await cancelCard(preservePocket: true)
        guard canceled else { return }
        await issueCard()
    }

    private func startAppleWalletFlow(_ card: CardItem) async {
        errorMessage = nil

        if let coordinator = AppleWalletProvisioningCoordinator.presentInAppProvisioningIfAvailable(
            card: card,
            holderName: holderName,
            api: app.api,
            onComplete: { added in
                walletCoordinator = nil
                if added {
                    showApplePaySuccess = true
                }
            }
        ) {
            walletCoordinator = coordinator
        } else {
            showAppleWalletSheet = true
            if cardSecrets == nil {
                await loadSecretsIfNeeded(card, authenticate: true)
            }
        }
    }
}

#Preview {
    CardView()
        .appEnvironment(.preview())
}
