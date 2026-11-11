import SwiftUI
import PassKit
import UIKit

/// Vista de Tarjeta CuyPay (Visa virtual respaldada en COP).
/// Presenta diseño limpio con datos reales integrados en línea, controles rápidos
/// y vinculación con Apple Wallet sin exponer marcas de terceros.
struct CardView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

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

    private var headerSurfaceColor: Color {
        colorScheme == .dark
            ? Theme.onyx
            : Color(red: 0.949, green: 0.953, blue: 0.965)
    }

    private var sheetSurfaceColor: Color {
        colorScheme == .dark
            ? Theme.jetBlack
            : Color(.systemBackground)
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                if let card = activeCard, store.cardsLoaded {
                    headerSurfaceColor.ignoresSafeArea()
                    ScrollView {
                        VStack(spacing: 0) {
                            cardCompactHeader(card)
                                .padding(.horizontal, 22)
                                .padding(.top, 14)
                                .padding(.bottom, 22)

                            VStack(alignment: .leading, spacing: 26) {
                                quickActionsRow(card)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 26)

                                if let errorMessage {
                                    ErrorBanner(message: errorMessage)
                                }

                                if needsCardContactReplacement {
                                    placeholderContactBanner
                                }

                                cardDataSection(card)

                                cardSettingsSection(card)
                            }
                            .padding(.horizontal, 20)
                            .padding(.bottom, 40)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                sheetSurfaceColor,
                                in: UnevenRoundedRectangle(
                                    topLeadingRadius: 28,
                                    bottomLeadingRadius: 0,
                                    bottomTrailingRadius: 0,
                                    topTrailingRadius: 28,
                                    style: .continuous
                                )
                            )
                        }
                    }
                    .scrollIndicators(.hidden)
                    .background(
                        VStack(spacing: 0) {
                            headerSurfaceColor.frame(height: 220)
                            sheetSurfaceColor
                        }
                        .ignoresSafeArea()
                    )
                } else {
                    BrandBackground()
                    ScrollView {
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
            }
            .navigationTitle(activeCard != nil ? "Tarjeta Virtual" : "Tarjeta CuyPay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                await app.refreshUser()
                await store.refreshCards()
            }
            .onDisappear {
                showSecrets = false
                cardSecrets = nil
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
                    Task { await cancelCard() }
                }
                Button("Volver", role: .cancel) {}
            } message: {
                Text("Esta acción es permanente y tu tarjeta actual dejará de funcionar de inmediato. Puedes emitir una nueva ahora mismo o crearla cuando quieras.")
            }
            .alert("Apple Wallet", isPresented: $showApplePaySuccess) {
                Button("Listo") {}
            } message: {
                Text("Tu tarjeta CuyPay quedó vinculada exitosamente a Apple Wallet.")
            }
        }
    }

    // MARK: - Encabezado compacto (Titular + Mini Tarjeta CuyPay)

    private func cardCompactHeader(_ card: CardItem) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: holderName)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)

                HStack(spacing: 8) {
                    Text(verbatim: headerSubtitle(for: card))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    if card.status == .frozen {
                        StatusBadge(text: "Bloqueada", color: Theme.warning, systemImage: "lock.fill")
                    } else if card.status == .canceled {
                        StatusBadge(text: "Cancelada", color: Theme.negative, systemImage: "xmark")
                    }
                }
            }

            Spacer(minLength: 8)

            miniCardThumbnail(card)
        }
    }

    private func headerSubtitle(for card: CardItem) -> String {
        let suffix = effectiveLastFour(for: card)
        if suffix.isEmpty {
            return card.label
        }
        return "\(card.label) •••• \(suffix)"
    }

    private func miniCardThumbnail(_ card: CardItem) -> some View {
        ZStack {
            LinearGradient(
                colors: card.status == .frozen
                    ? [Theme.jetBlack.opacity(0.75), Theme.onyx.opacity(0.85)]
                    : [Theme.spruceSolid, Theme.jetBlack, Theme.onyx],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            VStack {
                HStack(alignment: .top) {
                    CuyPayIsotype()
                        .fill(Color.white.opacity(0.92))
                        .frame(width: 15, height: 15)
                    Spacer()
                    Text("débito")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer()
                HStack {
                    if card.status == .frozen {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Theme.warning)
                    }
                    Spacer()
                    miniBrandMark(for: card.brand)
                }
            }
            .padding(10)
        }
        .frame(width: 106, height: 66)
        .clipShape(.rect(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.8)
        }
        .shadow(color: .black.opacity(0.14), radius: 8, x: 0, y: 4)
        .accessibilityHidden(true)
    }

    // MARK: - Botones circulares de acción rápida

    private func quickActionsRow(_ card: CardItem) -> some View {
        HStack(alignment: .top, spacing: 52) {
            circularActionButton(
                title: card.status == .frozen ? "Desbloquear\ntarjeta" : "Bloquear\ntarjeta",
                systemImage: card.status == .frozen ? "lock.open" : "lock",
                isLoading: isTogglingState,
                tint: card.status == .frozen ? Theme.warning : .primary,
                disabled: card.status == .canceled || isTogglingState
            ) {
                Task { await toggleFreeze(card) }
            }

            circularActionButton(
                title: "Apple\nWallet",
                systemImage: "wallet.pass",
                isLoading: false,
                tint: .primary,
                disabled: card.status != .active
            ) {
                Task { await startAppleWalletFlow(card) }
            }
        }
    }

    private func circularActionButton(
        title: LocalizedStringKey,
        systemImage: String,
        isLoading: Bool,
        tint: Color,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(colorScheme == .dark ? Color.white.opacity(0.08) : Color(red: 0.945, green: 0.949, blue: 0.961))
                        .frame(width: 62, height: 62)

                    if isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: systemImage)
                            .font(.system(size: 21, weight: .medium))
                            .foregroundStyle(tint)
                    }
                }

                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .opacity(disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    // MARK: - Tabla en línea "Datos de la tarjeta"

    private func cardDataSection(_ card: CardItem) -> some View {
        let borderColor = Color.primary.opacity(colorScheme == .dark ? 0.16 : 0.10)

        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Text("Datos de la tarjeta")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    Task { await toggleCardSecrets(card) }
                } label: {
                    HStack(spacing: 6) {
                        if isLoadingSecrets {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: showSecrets ? "eye.slash" : "eye")
                                .font(.footnote.weight(.semibold))
                        }
                        Text(showSecrets ? "Ocultar datos" : "Ver datos")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(Theme.spruce)
                }
                .buttonStyle(.plain)
                .disabled(card.status == .canceled || isLoadingSecrets)
            }

            VStack(spacing: 0) {
                // Fila 1: Nombre del titular
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Nombre")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text(verbatim: holderName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                    copyButton(value: holderName, id: "holder")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 15)

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 2: Número de la tarjeta (PAN real o enmascarado)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Número")
                            .font(.footnote)
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
                .padding(.vertical, 15)

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 3: Válida hasta | CVC
                HStack(spacing: 0) {
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Válida hasta")
                                .font(.footnote)
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
                    .padding(.vertical, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Rectangle()
                        .fill(borderColor)
                        .frame(width: 1)

                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("CVC")
                                .font(.footnote)
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
                    .padding(.vertical, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Rectangle()
                    .fill(borderColor)
                    .frame(height: 1)

                // Fila 4: Función | Franquicia (Visa / Mastercard)
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Función")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text("Débito")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Rectangle()
                        .fill(borderColor)
                        .frame(width: 1)

                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(verbatim: card.brand)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Text("Debit")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                        }
                        Spacer(minLength: 4)
                        tableBrandMark(for: card.brand)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(
                colorScheme == .dark ? Color.white.opacity(0.03) : Color(.systemBackground),
                in: .rect(cornerRadius: 16)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(borderColor, lineWidth: 1)
            }
        }
    }

    private func copyButton(value: String, id: String) -> some View {
        let isCopied = copiedField == id
        return Button {
            copyToPasteboard(value, id: id)
        } label: {
            Image(systemName: isCopied ? "checkmark" : "square.on.square")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(isCopied ? Theme.positive : .primary)
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
        return suffix.isEmpty ? "•••• •••• •••• ••••" : "•••• •••• •••• \(suffix)"
    }

    @ViewBuilder
    private func miniBrandMark(for brand: String) -> some View {
        if brand.lowercased().contains("master") {
            HStack(spacing: -5) {
                Circle().fill(Color(red: 0.92, green: 0.0, blue: 0.11)).frame(width: 14, height: 14)
                Circle().fill(Color(red: 0.97, green: 0.62, blue: 0.11).opacity(0.92)).frame(width: 14, height: 14)
            }
        } else {
            Text(verbatim: "VISA")
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .italic()
                .foregroundStyle(.white)
        }
    }

    @ViewBuilder
    private func tableBrandMark(for brand: String) -> some View {
        if brand.lowercased().contains("master") {
            HStack(spacing: -8) {
                Circle().fill(Color(red: 0.92, green: 0.0, blue: 0.11)).frame(width: 24, height: 24)
                Circle().fill(Color(red: 0.97, green: 0.62, blue: 0.11).opacity(0.92)).frame(width: 24, height: 24)
            }
        } else {
            Text(verbatim: "VISA")
                .font(.system(size: 16, weight: .black, design: .rounded))
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
                    Text("Esta tarjeta fue creada sin tu correo real. Actualiza tu correo y celular, y reemplázala gratis para recibir los códigos de Apple Wallet y compras.")
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
        .background(Theme.warning.opacity(colorScheme == .dark ? 0.14 : 0.10), in: .rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Theme.warning.opacity(0.35), lineWidth: 1)
        }
    }

    // MARK: - Sección "Configurar tarjeta"

    private func cardSettingsSection(_ card: CardItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Configurar tarjeta")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)

            settingsRow(
                icon: "wallet.pass",
                iconColor: .primary,
                title: "Agregar a Apple Wallet",
                subtitle: "Vincula tu tarjeta virtual para pagar sin contacto con tu iPhone o Apple Watch.",
                disabled: card.status != .active
            ) {
                Task { await startAppleWalletFlow(card) }
            }

            Divider()

            settingsRow(
                icon: "envelope.badge.shield.half.filled",
                iconColor: needsCardContactReplacement ? Theme.warning : Theme.spruce,
                title: "Correo y celular de códigos",
                subtitle: "\(verificationEmailSummary) · \(app.user?.phone ?? "") (reemplaza la tarjeta tras cambiar para actualizar Apple Wallet).",
                disabled: isCanceling || isIssuing
            ) {
                contactFollowUpAction = needsCardContactReplacement ? .replaceCard : nil
                showEditContactSheet = true
            }

            Divider()

            settingsRow(
                icon: "slider.horizontal.3",
                iconColor: .primary,
                title: "Personalizar tarjeta",
                subtitle: "Cambia la etiqueta visible de tu tarjeta (\(card.label)).",
                disabled: card.status == .canceled
            ) {
                newLabel = card.label
                showRename = true
            }

            Divider()

            settingsRow(
                icon: "trash",
                iconColor: Theme.negative,
                title: "Eliminar o reemplazar tarjeta",
                subtitle: "Elimina esta tarjeta y emite una nueva tarjeta virtual al instante.",
                disabled: card.status == .canceled || isCanceling || isIssuing
            ) {
                showCancelConfirm = true
            }
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
            HStack(alignment: .center, spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(iconColor)
                    .frame(width: 26)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(verbatim: subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
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
                        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))

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
                            .background(Color(.systemBackground), in: .rect(cornerRadius: 16))
                            .overlay {
                                RoundedRectangle(cornerRadius: 16)
                                    .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                            }

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
                    colors: [Theme.spruceSolid, Theme.jetBlack, Theme.onyx],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                VStack(alignment: .leading) {
                    HStack {
                        CuyPayLogo(size: 16, color: .white, markColor: .white)
                        Spacer()
                        Text(verbatim: "VISA")
                            .font(.system(.subheadline, design: .rounded).weight(.heavy))
                            .italic()
                            .foregroundStyle(.white.opacity(0.9))
                    }
                    Spacer()
                    Text(verbatim: "••••  ••••  ••••  ••••")
                        .font(.system(.title3, design: .monospaced).weight(.semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    Spacer()
                    Text(verbatim: holderName)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.9))
                }
                .padding(22)
            }
            .frame(height: 196)
            .clipShape(.rect(cornerRadius: 22))
            .shadow(color: .black.opacity(0.18), radius: 14, x: 0, y: 8)
            .padding(.top, 18)

            Text("Tu Tarjeta Virtual CuyPay")
                .font(.system(.title2, design: .serif).weight(.bold))
                .padding(.top, 4)

            Text("Crea gratis tu tarjeta virtual Visa en pesos colombianos para comprar en línea en comercios nacionales e internacionales.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)

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
            .padding(.top, 6)
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
    private func cancelCard() async -> Bool {
        guard let card = activeCard else { return false }
        isCanceling = true
        errorMessage = nil
        defer { isCanceling = false }
        do {
            _ = try await app.api.updateCardStatus(id: card.id, state: "canceled")
            cardSecrets = nil
            showSecrets = false
            await store.refreshCards()
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
        let canceled = await cancelCard()
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
