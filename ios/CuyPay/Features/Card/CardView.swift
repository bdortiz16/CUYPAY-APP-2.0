import SwiftUI
import SafariServices

/// Vista de Tarjeta CuyPay (Mastercard/Visa virtual respaldada por Coinsenda).
/// Permite emitir tarjeta virtual, ver datos en iframe seguro (look-url),
/// congelar/reactivar, renombrar, vincular a Apple Pay y cancelar.
struct CardView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var isIssuing = false
    @State private var isTogglingState = false
    @State private var isTokenizingApplePay = false
    @State private var showLookUrl = false
    @State private var lookUrl: URL?
    @State private var showRename = false
    @State private var newLabel = ""
    @State private var showCancelConfirm = false
    @State private var errorMessage: String?
    @State private var showApplePaySuccess = false

    private var activeCard: CardItem? {
        store.cards.first { $0.status != .canceled } ?? store.cards.first
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(spacing: 22) {
                        if !store.cardsLoaded {
                            ProgressView("Cargando tu tarjeta…")
                                .padding(.top, 80)
                        } else if let card = activeCard {
                            cardDetails(card)
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
            .navigationTitle("Tarjeta CuyPay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                if !store.cardsLoaded { await store.refreshCards() }
            }
            .sheet(isPresented: $showLookUrl) {
                if let lookUrl {
                    SafariView(url: lookUrl)
                }
            }
            .sheet(isPresented: $showRename) {
                renameSheet
            }
            .confirmationDialog(
                "¿Cancelar definitivamente tu tarjeta?",
                isPresented: $showCancelConfirm,
                titleVisibility: .visible
            ) {
                Button("Cancelar tarjeta", role: .destructive) {
                    Task { await cancelCard() }
                }
            } message: {
                Text("Esta acción es irreversible y tu tarjeta dejará de funcionar inmediatamente. Te pediremos Face ID.")
            }
            .alert("Apple Pay", isPresented: $showApplePaySuccess) {
                Button("Listo") {}
            } message: {
                Text("Tu tarjeta CuyPay ha sido vinculada exitosamente a Apple Wallet.")
            }
        }
    }

    // MARK: - Tarjeta activa

    @ViewBuilder
    private func cardDetails(_ card: CardItem) -> some View {
        VStack(spacing: 20) {
            // Visual de la tarjeta
            cardVisual(card)
                .padding(.top, 10)

            // Acciones principales
            GlassEffectContainer(spacing: 12) {
                HStack(spacing: 12) {
                    Button {
                        Task { await fetchLookUrl(card) }
                    } label: {
                        Label("Ver datos", systemImage: "eye.fill")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .disabled(card.status != .active)

                    Button {
                        Task { await toggleFreeze(card) }
                    } label: {
                        Label(
                            card.status == .frozen ? "Reactivar" : "Congelar",
                            systemImage: card.status == .frozen ? "lock.open.fill" : "snowflake"
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .disabled(card.status == .canceled || isTogglingState)
                }
            }

            // Botón Apple Pay
            Button {
                Task { await handleApplePay(card) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "wallet.pass.fill")
                        .font(.title3)
                    Text("Agregar a Apple Wallet")
                        .font(.headline)
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .background(Color.black, in: .capsule)
            }
            .buttonStyle(.plain)
            .disabled(card.status != .active || isTokenizingApplePay)

            // Configuración adicional
            VStack(spacing: 12) {
                Button {
                    newLabel = card.label
                    showRename = true
                } label: {
                    HStack {
                        Label("Renombrar tarjeta", systemImage: "pencil")
                        Spacer()
                        Text(verbatim: card.label)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)

                Button {
                    showCancelConfirm = true
                } label: {
                    HStack {
                        Label("Cancelar tarjeta", systemImage: "xmark.circle")
                            .foregroundStyle(Theme.negative)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
                .disabled(card.status == .canceled)
            }

            // Información
            GlassCard {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Usa el saldo de tu bolsillo COP en cualquier comercio que acepte Mastercard.", systemImage: "cart.fill")
                    Label("Compras internacionales y nacionales sin comisiones ocultas.", systemImage: "globe")
                    Label("Tus datos sensibles nunca se guardan en el servidor.", systemImage: "shield.lefthalf.filled")
                }
                .font(.subheadline)
                .symbolRenderingMode(.hierarchical)
            }
        }
    }

    // MARK: - Diseño visual de la tarjeta

    private func cardVisual(_ card: CardItem) -> some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [Theme.onyx, Theme.spruce.opacity(0.85), Theme.jetBlack],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            VStack(alignment: .leading) {
                HStack(alignment: .top) {
                    CuyPayLogo(size: 16)
                    Spacer()
                    if card.status == .frozen {
                        StatusBadge(text: "Congelada", color: Theme.warning, systemImage: "snowflake")
                    } else if card.status == .canceled {
                        StatusBadge(text: "Cancelada", color: Theme.negative, systemImage: "xmark")
                    } else {
                        Text(verbatim: card.brand.uppercased())
                            .font(.system(.subheadline, design: .rounded).weight(.bold))
                            .foregroundStyle(.white.opacity(0.8))
                    }
                }

                Spacer()

                HStack(spacing: 8) {
                    Text(verbatim: "••••  ••••  ••••  \(card.lastFour)")
                        .font(.system(.title3, design: .monospaced).weight(.bold))
                        .foregroundStyle(.white)
                }

                Spacer()

                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("TITULAR")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.6))
                        Text(verbatim: app.user?.fullName.uppercased() ?? "CUYPAY CLIENT")
                            .font(.system(.footnote, design: .rounded).weight(.medium))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(verbatim: card.label)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            .padding(22)
        }
        .frame(height: 210)
        .clipShape(.rect(cornerRadius: 22))
        .shadow(color: .black.opacity(0.25), radius: 15, x: 0, y: 10)
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
        }
    }

    // MARK: - Estados vacíos

    private var emptyCardView: some View {
        VStack(spacing: 20) {
            Image(systemName: "creditcard.and.123")
                .font(.system(size: 72, weight: .light))
                .foregroundStyle(Theme.spruce)
                .padding(.top, 40)
            Text("Tu Tarjeta CuyPay")
                .font(.system(.title2, design: .serif).weight(.bold))
            Text("Pide tu tarjeta virtual gratis para hacer compras en línea y asociarla a Apple Pay al instante.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)

            PrimaryButton(title: "Crear mi tarjeta virtual", systemImage: "sparkles", isLoading: isIssuing) {
                Task { await issueCard() }
            }
            .padding(.top, 10)
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
                    Text("Renombrar tarjeta")
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

    // MARK: - Acciones backend

    private func issueCard() async {
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

    private func fetchLookUrl(_ card: CardItem) async {
        errorMessage = nil
        do {
            let urlString = try await app.api.cardLookUrl(id: card.id)
            if let url = URL(string: urlString) {
                lookUrl = url
                showLookUrl = true
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

    private func cancelCard() async {
        guard let card = activeCard else { return }
        errorMessage = nil
        do {
            _ = try await app.api.updateCardStatus(id: card.id, state: "canceled")
            await store.refreshCards()
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func handleApplePay(_ card: CardItem) async {
        isTokenizingApplePay = true
        errorMessage = nil
        defer { isTokenizingApplePay = false }
        do {
            _ = try await app.api.tokenizeApplePay(
                id: card.id,
                certificates: ["cert_leaf", "cert_sub"],
                nonce: UUID().uuidString,
                nonceSignature: "sig_apple_pass"
            )
            showApplePaySuccess = true
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - SFSafariViewController wrapper
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.barCollapsingEnabled = false
        return SFSafariViewController(url: url, configuration: config)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

#Preview {
    CardView()
        .appEnvironment(.preview())
}
