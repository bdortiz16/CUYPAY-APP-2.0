import SwiftUI
import UIKit

/// Recibir COP: muestra la llave Bre-B propia (grande, copiar/compartir, QR) o permite crearla (🔐).
struct ReceiveView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var preferredAlias = ""
    @State private var isCreating = false
    @State private var errorMessage: String?
    @State private var copied = false
    @State private var createdCount = 0

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(spacing: 20) {
                        if !store.brebKeyLoaded {
                            ProgressView("Cargando tu llave…")
                                .padding(.top, 80)
                        } else if let key = store.brebKey {
                            keyContent(key)
                        } else if !app.isKYCApproved {
                            kycRequired
                        } else {
                            createContent
                        }
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Recibir")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                if !store.brebKeyLoaded { await store.refreshBrebKey() }
            }
            .sensoryFeedback(.success, trigger: copied) { _, newValue in newValue }
            .sensoryFeedback(.success, trigger: createdCount)
        }
    }

    // MARK: Llave existente

    private func keyContent(_ key: BrebKey) -> some View {
        VStack(spacing: 20) {
            VStack(spacing: 8) {
                Text("Tu llave Bre-B")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(verbatim: key.alias)
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .textSelection(.enabled)
                    .accessibilityLabel(Text("Llave \(key.alias)"))
                Text(verbatim: key.holderName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if key.status != .active {
                    StatusBadge(
                        text: key.status == .pending ? "Activándose" : "Bloqueada",
                        color: key.status == .pending ? Theme.warning : Theme.negative,
                        systemImage: key.status == .pending ? "clock.fill" : "lock.fill"
                    )
                }
            }
            .padding(.top, 12)

            if let image = QRCodeGenerator.image(for: key.alias) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .padding(18)
                    .background(.white, in: .rect(cornerRadius: 24))
                    .padding(10)
                    .glassEffect(.regular, in: .rect(cornerRadius: 32))
                    .accessibilityLabel(Text("Código QR de tu llave Bre-B"))
            }

            GlassEffectContainer(spacing: 12) {
                HStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = key.alias
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            copied = false
                        }
                    } label: {
                        Label(copied ? LocalizedStringKey("¡Copiada!") : LocalizedStringKey("Copiar"), systemImage: copied ? "checkmark" : "doc.on.doc")
                            .contentTransition(.symbolEffect(.replace))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)

                    ShareLink(
                        item: key.alias,
                        subject: Text("Mi llave Bre-B"),
                        message: Text("Envíame dinero por Bre-B a mi llave \(key.alias) (CuyPay).")
                    ) {
                        Label("Compartir", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                }
            }

            GlassCard {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Recibe desde cualquier banco o billetera conectada a Bre-B.", systemImage: "building.columns")
                    Label("El dinero llega a tu bolsillo COP en segundos, 24/7.", systemImage: "bolt.fill")
                    Label("Comparte solo tu llave: nunca pidas claves ni códigos.", systemImage: "hand.raised.fill")
                }
                .font(.subheadline)
                .symbolRenderingMode(.hierarchical)
            }
        }
    }

    // MARK: Crear llave

    private var createContent: some View {
        VStack(spacing: 20) {
            Image(systemName: "key.viewfinder")
                .font(.system(size: 72, weight: .light))
                .foregroundStyle(Theme.spruce)
                .padding(.top, 24)
            Text("Crea tu llave Bre-B")
                .font(.system(.title, design: .rounded).weight(.bold))
            Text("Con tu llave cualquier persona te puede enviar pesos desde su banco, al instante.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("Alias preferido (opcional)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    Text(verbatim: "@")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("cuypaytunombre", text: $preferredAlias)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .formFieldStyle()
                Text("Si lo dejas vacío, generamos uno que empieza por @cuypay.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            PrimaryButton(title: "Crear mi llave Bre-B", systemImage: "faceid", isLoading: isCreating) {
                Task { await createKey() }
            }
            Label("Te pediremos Face ID para firmar esta operación.", systemImage: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var kycRequired: some View {
        ContentUnavailableView {
            Label("Verifica tu identidad", systemImage: "person.badge.shield.checkmark")
        } description: {
            Text("Para crear tu llave Bre-B necesitamos verificar tu identidad.")
        }
        .padding(.top, 40)
    }

    private func createKey() async {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        let alias = preferredAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let key = try await app.api.createBrebKey(preferredAlias: alias.isEmpty ? nil : "@" + alias.trimmingCharacters(in: CharacterSet(charactersIn: "@")))
            withAnimation(.smooth) {
                store.brebKey = key
            }
            createdCount += 1
        } catch {
            errorMessage = error.userMessage
        }
    }
}

#Preview("Recibir") {
    ReceiveView()
        .appEnvironment(.preview())
}
