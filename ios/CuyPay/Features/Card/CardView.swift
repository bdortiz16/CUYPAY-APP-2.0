import SwiftUI
import PassKit
import UIKit

/// Vista limpia y minimalista de Mi Tarjeta CuyPay (Visa virtual en COP con bolsillo independiente sin costo).
/// Separa la tarjeta hero sin recortes, su bolsillo conectado a Bre-B, acciones rápidas,
/// Apple Wallet y hojas dedicadas para Datos seguros y Ajustes (sin edición de correo/celular aquí).
struct CardView: View {
    var onOpenProfile: (() -> Void)? = nil

    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppModel.hideAmountsKey) private var hideAmounts = false

    @State private var isIssuing = false
    @State private var isCanceling = false
    @State private var isTogglingState = false
    @State private var isLoadingSecrets = false
    @State private var cardSecrets: CardSensitiveDetails?
    @State private var isCardFlipped = false
    @State private var showCardBackFace = false
    @State private var flipSwapTask: Task<Void, Never>?
    @State private var showCardSettingsSheet = false
    @State private var copiedField: String?
    @State private var pocketTransferMode: CardPocketTransferMode?
    @State private var pocketFeedbackMessage: String?
    @State private var selectedTransaction: WalletTransaction?
    @State private var showRename = false
    @State private var newLabel = ""
    @State private var showCancelConfirm = false
    @State private var showAppleWalletSheet = false
    @State private var showApplePaySuccess = false
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
            return String(localized: "Pendiente en tu perfil")
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
                        VStack(alignment: .leading, spacing: 20) {
                            virtualCardShowcase(card)
                                .padding(.top, 8)

                            quickActionsRow(card)

                            if let pocketFeedbackMessage {
                                pocketSuccessBanner(pocketFeedbackMessage)
                                    .transition(.move(edge: .top).combined(with: .opacity))
                            }

                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            if needsCardContactReplacement {
                                securityProfileNoticeBanner
                            }

                            cardPocketSummaryCard(card)

                            if card.status == .active {
                                appleWalletBannerButton(card)
                            }

                            cardMovementsSection
                        }
                        .padding(.horizontal, 20)
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
                resetCardFlipImmediately()
                cardSecrets = nil
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase != .active && isCardFlipped {
                    setCardFlipped(false)
                }
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
            .sheet(isPresented: $showCardSettingsSheet) {
                if let card = activeCard {
                    cardSettingsSheet(card)
                }
            }
            .sheet(isPresented: $showRename) {
                renameSheet
            }
            .sheet(isPresented: $showAppleWalletSheet) {
                if let card = activeCard {
                    appleWalletSheet(card)
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

    // MARK: - 1. Tarjeta Virtual CuyPay con giro 3D interactivo (Frente limpio sin chip + Reverso con datos reales)

    private func virtualCardShowcase(_ card: CardItem) -> some View {
        ZStack {
            virtualCardFront(card)
                .opacity(showCardBackFace ? 0 : 1)
                .allowsHitTesting(!showCardBackFace)
                .rotation3DEffect(
                    .degrees(isCardFlipped ? 180 : 0),
                    axis: (x: 0, y: 1, z: 0),
                    perspective: 0.42
                )

            virtualCardBack(card)
                .opacity(showCardBackFace ? 1 : 0)
                .allowsHitTesting(showCardBackFace)
                .rotation3DEffect(
                    .degrees(isCardFlipped ? 0 : -180),
                    axis: (x: 0, y: 1, z: 0),
                    perspective: 0.42
                )
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.42 : 0.18), radius: 20, x: 0, y: 11)
    }

    private func virtualCardFront(_ card: CardItem) -> some View {
        let isFrozen = card.status == .frozen
        let last4 = effectiveLastFour(for: card)

        return VStack(alignment: .leading, spacing: 0) {
            // Fila superior: Marca CuyPay + Estado + Sin contacto
            HStack(alignment: .center, spacing: 10) {
                CuyPayLogo(size: 16.5, color: .white, markColor: Theme.slate)

                Spacer()

                HStack(spacing: 5) {
                    Circle()
                        .fill(isFrozen ? Theme.warning : Theme.positive)
                        .frame(width: 6, height: 6)
                    Text(isFrozen ? "Bloqueada" : "Activa")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.96))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.white.opacity(0.12), in: .capsule)

                Image(systemName: "wave.3.forward")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.84))
            }

            Spacer(minLength: 20)

            // Zona central limpia (sin chip físico): numeración digital con jerarquía sutil
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                ForEach(0..<3, id: \.self) { _ in
                    Text(verbatim: "••••")
                        .font(.system(size: 17, weight: .semibold, design: .monospaced))
                        .tracking(1.6)
                        .foregroundStyle(.white.opacity(0.46))
                }
                Text(verbatim: last4.isEmpty ? "••••" : last4)
                    .font(.system(size: 19, weight: .semibold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(.white.opacity(0.96))
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)

            Spacer(minLength: 20)

            // Fila inferior: Etiqueta + Titular + Logo vectorial oficial Visa
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: card.label.uppercased())
                        .font(.system(size: 9.5, weight: .semibold))
                        .tracking(1.0)
                        .foregroundStyle(Theme.slate.opacity(0.90))
                        .lineLimit(1)
                    Text(verbatim: holderName)
                        .font(.system(size: 14.5, weight: .bold, design: .rounded))
                        .tracking(0.3)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 4) {
                    cardBrandHeroMark(for: card.brand, height: 19)
                    Text("Débito COP")
                        .font(.system(size: 9.5, weight: .medium))
                        .tracking(0.3)
                        .foregroundStyle(.white.opacity(0.74))
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity)
        .frame(height: 220)
        .background {
            cardSurfaceBackground(isFrozen: isFrozen, isBack: false)
        }
        .clipShape(.rect(cornerRadius: 26))
        .overlay {
            cardRimBorder
        }
        .contentShape(.rect(cornerRadius: 26))
        .onTapGesture {
            guard card.status != .canceled, !isLoadingSecrets else { return }
            Task { await toggleCardDetailsFlip(card) }
        }
    }

    private func virtualCardBack(_ card: CardItem) -> some View {
        let isFrozen = card.status == .frozen

        return VStack(alignment: .leading, spacing: 11) {
            // Cabecera del reverso: indicador de seguridad / aviso de copiado + botón para volver al frente
            HStack(spacing: 8) {
                if let copiedField {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.positive)
                        Text(copiedFieldLabel(for: copiedField))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Theme.positive.opacity(0.24), in: .capsule)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
                } else {
                    HStack(spacing: 5) {
                        Image(systemName: "lock.shield.fill")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.slate)
                        Text("Toca un dato para copiar")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(0.78))
                    }
                }

                Spacer(minLength: 6)

                Button {
                    setCardFlipped(false)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 10, weight: .bold))
                        Text("Frente")
                            .font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.white.opacity(0.14), in: .capsule)
                }
                .buttonStyle(.plain)
            }

            if let secrets = cardSecrets {
                // Bloque principal: Número completo de tarjeta (16 dígitos) con copiado a 1 toque
                Button {
                    copyToPasteboard(secrets.rawPan, id: "pan")
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("NÚMERO DE TARJETA")
                                .font(.system(size: 8.5, weight: .semibold))
                                .tracking(0.9)
                                .foregroundStyle(Theme.slate.opacity(0.90))
                            Text(verbatim: secrets.formattedPan)
                                .font(.system(size: 17.5, weight: .bold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                        }

                        Spacer(minLength: 4)

                        Image(systemName: copiedField == "pan" ? "checkmark.circle.fill" : "doc.on.doc")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(copiedField == "pan" ? Theme.positive : .white.opacity(0.85))
                            .frame(width: 30, height: 30)
                            .background(Color.white.opacity(0.10), in: .circle)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.08), in: .rect(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)
                    }
                }
                .buttonStyle(.plain)

                // Fila inferior: Vencimiento + CVC + Titular y marca Visa
                HStack(alignment: .center, spacing: 10) {
                    backSecretTile(
                        label: "VENCE",
                        value: secrets.expiry,
                        copyValue: secrets.expiry,
                        id: "exp"
                    )

                    backSecretTile(
                        label: "CVC",
                        value: secrets.cvv,
                        copyValue: secrets.cvv,
                        id: "cvv"
                    )

                    Spacer(minLength: 4)

                    VStack(alignment: .trailing, spacing: 4) {
                        cardBrandHeroMark(for: card.brand, height: 16)
                        Text(verbatim: holderName)
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.70))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                }
            } else {
                Spacer()
                HStack(spacing: 10) {
                    ProgressView()
                        .tint(.white)
                    Text("Descifrando datos seguros…")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white.opacity(0.85))
                }
                .frame(maxWidth: .infinity, alignment: .center)
                Spacer()
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity)
        .frame(height: 220)
        .background {
            cardSurfaceBackground(isFrozen: isFrozen, isBack: true)
        }
        .clipShape(.rect(cornerRadius: 26))
        .overlay {
            cardRimBorder
        }
    }

    private func backSecretTile(label: String, value: String, copyValue: String, id: String) -> some View {
        let isCopied = copiedField == id
        return Button {
            copyToPasteboard(copyValue, id: id)
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: label)
                        .font(.system(size: 8.5, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(Theme.slate.opacity(0.90))
                    Text(verbatim: value)
                        .font(.system(size: 15, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                Image(systemName: isCopied ? "checkmark.circle.fill" : "doc.on.doc")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isCopied ? Theme.positive : .white.opacity(0.75))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.08), in: .rect(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)
            }
        }
        .buttonStyle(.plain)
    }

    private func cardSurfaceBackground(isFrozen: Bool, isBack: Bool) -> some View {
        ZStack {
            LinearGradient(
                colors: isFrozen
                    ? [Color(red: 0.08, green: 0.10, blue: 0.11), Theme.jetBlack.opacity(0.92), Color(white: 0.23)]
                    : (isBack
                        ? [Color(red: 0.028, green: 0.058, blue: 0.070), Theme.onyx, Color(red: 0.055, green: 0.165, blue: 0.180)]
                        : [Color(red: 0.035, green: 0.075, blue: 0.090), Theme.onyx, Theme.spruceSolid]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            RadialGradient(
                colors: [
                    (isFrozen ? Color.white : Theme.slate).opacity(isBack ? 0.16 : 0.28),
                    Color.clear
                ],
                center: isBack ? .bottomLeading : .topTrailing,
                startRadius: 10,
                endRadius: 230
            )

            if !isBack {
                GeometryReader { proxy in
                    ZStack {
                        CuyPayIsotype()
                            .fill(Color.white.opacity(0.036))
                            .frame(width: 180, height: 180)
                            .position(x: proxy.size.width - 52, y: proxy.size.height * 0.46)

                        Circle()
                            .strokeBorder(
                                LinearGradient(
                                    colors: [Color.white.opacity(0.10), Color.clear],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                lineWidth: 1
                            )
                            .frame(width: 250, height: 250)
                            .position(x: proxy.size.width - 15, y: 12)
                    }
                }
            }
        }
    }

    private var cardRimBorder: some View {
        RoundedRectangle(cornerRadius: 26)
            .strokeBorder(
                LinearGradient(
                    colors: [.white.opacity(0.32), .white.opacity(0.06), .white.opacity(0.16)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                lineWidth: 1
            )
    }

    // MARK: - 2. Fila limpia de 4 acciones rápidas

    private func quickActionsRow(_ card: CardItem) -> some View {
        HStack(spacing: 10) {
            quickActionButton(
                title: "Recargar",
                systemImage: "plus",
                isPrimary: true,
                isLoading: false,
                disabled: card.status == .canceled
            ) {
                pocketTransferMode = .fund
            }

            quickActionButton(
                title: isCardFlipped ? "Ocultar" : "Ver datos",
                systemImage: isCardFlipped ? "eye.slash.fill" : "creditcard.and.123",
                isPrimary: false,
                isLoading: isLoadingSecrets,
                tint: isCardFlipped ? Theme.spruce : .primary,
                disabled: card.status == .canceled || isLoadingSecrets
            ) {
                Task { await toggleCardDetailsFlip(card) }
            }

            quickActionButton(
                title: card.status == .frozen ? "Activar" : "Bloquear",
                systemImage: card.status == .frozen ? "lock.open.fill" : "lock.fill",
                isPrimary: false,
                isLoading: isTogglingState,
                tint: card.status == .frozen ? Theme.warning : .primary,
                disabled: card.status == .canceled || isTogglingState
            ) {
                Task { await toggleFreeze(card) }
            }

            quickActionButton(
                title: "Ajustes",
                systemImage: "slider.horizontal.3",
                isPrimary: false,
                isLoading: false,
                disabled: card.status == .canceled
            ) {
                showCardSettingsSheet = true
            }
        }
    }

    private func quickActionButton(
        title: LocalizedStringKey,
        systemImage: String,
        isPrimary: Bool,
        isLoading: Bool,
        tint: Color = .primary,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(isPrimary ? Theme.spruceSolid : tint.opacity(0.10))
                        .frame(width: 44, height: 44)

                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(isPrimary ? .white : tint)
                    } else {
                        Image(systemName: systemImage)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(isPrimary ? .white : tint)
                    }
                }

                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
            .contentShape(.rect(cornerRadius: 20))
            .opacity(disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
    }

    // MARK: - 3. Tarjeta limpia del bolsillo de compras

    private func cardPocketSummaryCard(_ card: CardItem) -> some View {
        let pocket = card.pocketBalance
        let mainCop = store.copMainAvailable
        let canWithdraw = pocket.minorUnits >= 10_000

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 8) {
                Label("Bolsillo de tu tarjeta", systemImage: "wallet.bifold.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .symbolRenderingMode(.hierarchical)

                Spacer()

                Text("$ 0 comisión")
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
                        .frame(width: 28, height: 28)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hideAmounts ? Text("Mostrar saldo") : Text("Ocultar saldo"))
            }

            VStack(alignment: .leading, spacing: 4) {
                pocketAmountText(pocket)

                Text(pocket.minorUnits > 0
                     ? "Disponible de inmediato para tus compras virtuales y sin contacto."
                     : "Pasa saldo desde tu cuenta principal Bre-B para comprar con tu tarjeta.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            HStack(spacing: 10) {
                Text(verbatim: "🇨🇴")
                    .font(.subheadline)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Saldo principal Bre-B")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: hideAmounts ? mainCop.maskedString : mainCop.formatted())
                        .font(.footnote.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }

                Spacer()

                if canWithdraw {
                    Button {
                        pocketTransferMode = .withdraw
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.caption.weight(.bold))
                            Text("A principal")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(Theme.spruce)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Theme.spruce.opacity(0.12), in: .capsule)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        pocketTransferMode = .fund
                    } label: {
                        Text("Pasar saldo")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.spruce)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Theme.spruce.opacity(0.12), in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    // MARK: - 4. Botón limpio de Apple Wallet

    private func appleWalletBannerButton(_ card: CardItem) -> some View {
        Button {
            Task { await startAppleWalletFlow(card) }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.white.opacity(0.14))
                        .frame(width: 38, height: 38)
                    Image(systemName: "wallet.pass.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Agregar a Apple Wallet")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("Paga sin contacto con tu iPhone o Apple Watch")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.76))
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .background(Color.black, in: .rect(cornerRadius: 20))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 5. Movimientos de tu tarjeta

    private var cardMovementsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Movimientos de tu tarjeta")
                .font(.system(.subheadline, design: .serif).weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 4)

            if store.cardTransactions.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "creditcard")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 34, height: 34)
                        .background(Color.primary.opacity(0.06), in: .circle)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sin movimientos aún")
                            .font(.subheadline.weight(.medium))
                        Text("Tus compras y recargas de bolsillo aparecerán aquí.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(16)
                .glassEffect(.regular, in: .rect(cornerRadius: 20))
            } else {
                VStack(spacing: 4) {
                    ForEach(Array(store.cardTransactions.prefix(5))) { txn in
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
    }

    // MARK: - Aviso informativo (remite a Perfil y seguridad, sin editar aquí)

    private var securityProfileNoticeBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lock.shield.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Verifica tus datos en Perfil y seguridad")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.primary)
                    Text("Por tu seguridad, el correo y el celular solo se actualizan desde tu perfil mediante código de verificación. Luego podrás reemplazar tu tarjeta conservando tu bolsillo.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if onOpenProfile != nil {
                Button {
                    navigateToProfile()
                } label: {
                    HStack(spacing: 6) {
                        Text("Ir a Perfil y seguridad")
                            .font(.caption.weight(.semibold))
                        Image(systemName: "arrow.right")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(Theme.spruce)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warning.opacity(colorScheme == .dark ? 0.14 : 0.10), in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Theme.warning.opacity(0.30), lineWidth: 1)
        }
    }

    // MARK: - Fila auxiliar de copiado (usada en Apple Wallet guiado)

    private func secretDetailRow(label: LocalizedStringKey, value: String, copyValue: String, id: String) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(verbatim: value)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 4)
            copyButton(value: copyValue, id: id)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Hoja modal dedicada: Ajustes de tarjeta (sin editar correo/celular)

    private func cardSettingsSheet(_ card: CardItem) -> some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Ajustes de tarjeta")
                            .font(.system(.title3, design: .serif).weight(.semibold))
                            .padding(.top, 8)

                        VStack(spacing: 0) {
                            settingsActionRow(
                                icon: "pencil.line",
                                iconColor: Theme.spruce,
                                title: "Personalizar nombre",
                                subtitle: "Etiqueta visible: \(card.label)"
                            ) {
                                showCardSettingsSheet = false
                                Task {
                                    try? await Task.sleep(for: .milliseconds(220))
                                    newLabel = card.label
                                    showRename = true
                                }
                            }

                            if card.pocketBalance.minorUnits >= 10_000 {
                                Divider().padding(.leading, 52)

                                settingsActionRow(
                                    icon: "arrow.uturn.backward.circle",
                                    iconColor: Theme.spruce,
                                    title: "Pasar saldo a cuenta principal",
                                    subtitle: "Disponible en tarjeta: \(card.pocketBalance.formatted())"
                                ) {
                                    showCardSettingsSheet = false
                                    Task {
                                        try? await Task.sleep(for: .milliseconds(220))
                                        pocketTransferMode = .withdraw
                                    }
                                }
                            }

                            Divider().padding(.leading, 52)

                            settingsActionRow(
                                icon: "trash",
                                iconColor: Theme.negative,
                                title: "Eliminar o reemplazar tarjeta",
                                subtitle: "Reemplázala conservando tu bolsillo o devuelve el saldo a Bre-B."
                            ) {
                                showCardSettingsSheet = false
                                Task {
                                    try? await Task.sleep(for: .milliseconds(220))
                                    showCancelConfirm = true
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 4)
                        .glassEffect(.regular, in: .rect(cornerRadius: 22))

                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "lock.shield")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text("Por seguridad, cualquier cambio de correo electrónico o celular se realiza únicamente desde Perfil y seguridad con código de verificación.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 6)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 28)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { showCardSettingsSheet = false }
                }
            }
        }
        .presentationDetents([.height(360), .medium])
    }

    private func settingsActionRow(
        icon: String,
        iconColor: Color,
        title: LocalizedStringKey,
        subtitle: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(iconColor.opacity(0.12))
                        .frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(iconColor)
                }

                VStack(alignment: .leading, spacing: 2) {
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
        }
        .buttonStyle(.plain)
    }

    // MARK: - Hoja guiada de Apple Wallet (sin edición de contacto)

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

                        Text("Copia los datos de tu tarjeta virtual y toca **Abrir Apple Wallet** para agregarla en segundos.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "lock.shield.fill")
                                .foregroundStyle(Theme.spruce)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(verbatim: "Códigos enviados a: \(verificationEmailSummary) · \(app.user?.phone ?? "")")
                                    .font(.caption.weight(.semibold))
                                Text("Para cambiar tu correo o celular ve a Perfil y seguridad.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
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
                                secretDetailRow(label: "Número de tarjeta", value: secrets.formattedPan, copyValue: secrets.rawPan, id: "w_pan")
                                Divider()
                                secretDetailRow(label: "Válida hasta", value: secrets.expiry, copyValue: secrets.expiry, id: "w_exp")
                                Divider()
                                secretDetailRow(label: "Código de seguridad (CVC)", value: secrets.cvv, copyValue: secrets.cvv, id: "w_cvv")
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
        .presentationDetents([.height(520), .large])
    }

    // MARK: - Estados vacíos

    private var emptyCardView: some View {
        VStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    CuyPayLogo(size: 16.5, color: .white, markColor: Theme.slate)
                    Spacer()
                    Image(systemName: "wave.3.forward")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.80))
                }
                Spacer()
                HStack(spacing: 12) {
                    ForEach(0..<4, id: \.self) { _ in
                        Text(verbatim: "••••")
                            .font(.system(size: 17, weight: .semibold, design: .monospaced))
                            .tracking(1.6)
                            .foregroundStyle(.white.opacity(0.55))
                    }
                }
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("BOLSILLO COP · $ 0 COMISIÓN")
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(0.9)
                            .foregroundStyle(Theme.slate.opacity(0.90))
                        Text(verbatim: holderName)
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.96))
                            .lineLimit(1)
                    }
                    Spacer()
                    VisaLogoView(height: 18, color: .white.opacity(0.96))
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity)
            .frame(height: 214)
            .background {
                cardSurfaceBackground(isFrozen: false, isBack: false)
            }
            .clipShape(.rect(cornerRadius: 26))
            .overlay {
                cardRimBorder
            }
            .shadow(color: .black.opacity(0.20), radius: 16, x: 0, y: 9)
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

            if app.user?.hasPlaceholderContact == true {
                securityProfileNoticeBanner
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

    // MARK: - Helpers visuales y formato

    @ViewBuilder
    private func pocketAmountText(_ amount: Money) -> some View {
        if hideAmounts {
            Text(verbatim: amount.maskedString)
                .font(.system(size: 34, weight: .regular, design: .serif))
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
            .font(.system(size: 34, weight: .regular, design: .serif))
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

    private func copiedFieldLabel(for id: String) -> LocalizedStringKey {
        switch id {
        case "pan": "Número copiado"
        case "exp": "Vencimiento copiado"
        case "cvv": "CVC copiado"
        default: "Copiado"
        }
    }

    @ViewBuilder
    private func cardBrandHeroMark(for brand: String, height: CGFloat = 19) -> some View {
        if brand.lowercased().contains("master") {
            HStack(spacing: -height * 0.3) {
                Circle().fill(Color(red: 0.92, green: 0.0, blue: 0.11)).frame(width: height, height: height)
                Circle().fill(Color(red: 0.97, green: 0.62, blue: 0.11).opacity(0.92)).frame(width: height, height: height)
            }
        } else {
            VisaLogoView(height: height, color: .white)
        }
    }

    private func navigateToProfile() {
        if let onOpenProfile {
            onOpenProfile()
        } else {
            dismiss()
        }
    }

    private func setCardFlipped(_ target: Bool) {
        guard target != isCardFlipped else { return }
        flipSwapTask?.cancel()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        withAnimation(.spring(duration: 0.56, bounce: 0.10)) {
            isCardFlipped = target
        }
        flipSwapTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(240))
            guard !Task.isCancelled else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                showCardBackFace = target
            }
        }
    }

    private func resetCardFlipImmediately() {
        flipSwapTask?.cancel()
        flipSwapTask = nil
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            isCardFlipped = false
            showCardBackFace = false
        }
    }

    // MARK: - Acciones

    private func issueCard() async {
        if app.user?.hasPlaceholderContact == true {
            errorMessage = String(localized: "Confirma primero tu correo y celular mediante código de seguridad en Perfil y seguridad.")
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

    private func toggleCardDetailsFlip(_ card: CardItem) async {
        if isCardFlipped {
            setCardFlipped(false)
            return
        }
        let unlocked = await loadSecretsIfNeeded(card, authenticate: true)
        if unlocked {
            setCardFlipped(true)
        }
    }

    @discardableResult
    private func loadSecretsIfNeeded(_ card: CardItem, authenticate: Bool) async -> Bool {
        errorMessage = nil
        if cardSecrets != nil {
            if authenticate {
                let authorized = await BiometricAuthenticator.authenticate(
                    reason: String(localized: "Autoriza ver los datos de tu tarjeta CuyPay")
                )
                return authorized
            }
            return true
        }

        if authenticate {
            let authorized = await BiometricAuthenticator.authenticate(
                reason: String(localized: "Autoriza ver los datos de tu tarjeta CuyPay")
            )
            guard authorized else { return false }
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
            cardSecrets = details
            if card.lastFour == "0000" {
                await store.refreshCards()
            }
            return true
        } catch {
            errorMessage = error.userMessage
            return false
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
            resetCardFlipImmediately()
            cardSecrets = nil
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
            errorMessage = String(localized: "Primero actualiza tu correo y celular con código de seguridad en Perfil y seguridad.")
            return
        }
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
                _ = await loadSecretsIfNeeded(card, authenticate: true)
            }
        }
    }
}

#Preview {
    CardView()
        .appEnvironment(.preview())
}
