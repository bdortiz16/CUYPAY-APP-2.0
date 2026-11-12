import SwiftUI
import UIKit

/// Recibir COP: muestra la llave Bre-B propia (grande, copiar/compartir, QR) o permite generarla automáticamente por el sistema (🔐).
struct ReceiveView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var isCreating = false
    @State private var isChanging = false
    @State private var isDeleting = false
    @State private var showRegenerateConfirm = false
    @State private var showDeleteConfirm = false
    @State private var showKYCSheet = false
    @State private var errorMessage: String?
    @State private var copied = false
    @State private var didDeleteKey = false
    @State private var createdCount = 0
    @State private var deletedCount = 0

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(spacing: 20) {
                        Group {
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
                        }
                        .id(store.brebKey?.id ?? "create-breb-key")

                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                    .animation(.snappy, value: store.brebKey?.id)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Recibir")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                await store.refreshBrebKey()
            }
            .sensoryFeedback(.success, trigger: copied) { _, newValue in newValue }
            .sensoryFeedback(.success, trigger: createdCount)
            .sensoryFeedback(.success, trigger: deletedCount)
            .sheet(isPresented: $showKYCSheet) {
                KYCFlowSheet()
            }
            .confirmationDialog(
                "¿Generar una nueva llave Bre-B?",
                isPresented: $showRegenerateConfirm,
                titleVisibility: .visible
            ) {
                Button("Generar nueva llave") {
                    Task { await regenerateKey() }
                }
            } message: {
                Text("El sistema te asignará automáticamente una nueva llave genérica Bre-B y tu llave actual quedará desactivada. Se confirmará con Face ID.")
            }
            .confirmationDialog(
                "¿Eliminar tu llave Bre-B?",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Eliminar llave", role: .destructive) {
                    Task { await deleteKey() }
                }
            } message: {
                Text("Ya no podrás recibir dinero por Bre-B hasta que generes una nueva llave automática. Se confirmará con Face ID.")
            }
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

            HStack(spacing: 12) {
                Button {
                    errorMessage = nil
                    showRegenerateConfirm = true
                } label: {
                    HStack(spacing: 6) {
                        if isChanging {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text(isChanging ? "Generando…" : "Nueva llave")
                    }
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.glass)
                .disabled(isChanging || isDeleting)

                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    HStack(spacing: 6) {
                        if isDeleting {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text(isDeleting ? "Eliminando…" : "Eliminar")
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.negative)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.glass)
                .disabled(isDeleting || isChanging)
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

    // MARK: Generar llave automática por el sistema

    private var createContent: some View {
        VStack(spacing: 20) {
            if didDeleteKey {
                GlassCard {
                    HStack(spacing: 12) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.spruce)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Llave Bre-B eliminada")
                                .font(.subheadline.weight(.semibold))
                            Text("Genera una nueva llave automática abajo o cierra esta ventana.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Button("Cerrar") {
                            dismiss()
                        }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered)
                        .tint(Theme.spruce)
                    }
                }
                .padding(.top, 8)
            }

            Image(systemName: "key.viewfinder")
                .font(.system(size: 68, weight: .light))
                .foregroundStyle(Theme.spruce)
                .padding(.top, didDeleteKey ? 4 : 24)

            Text("Genera tu llave Bre-B")
                .font(.system(.title, design: .rounded).weight(.bold))

            Text("El sistema te asignará automáticamente una llave única Bre-B para que recibas pesos desde cualquier banco o billetera al instante, 24/7.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Asignación automática e inmediata por el sistema.", systemImage: "checkmark.seal.fill")
                    Label("Recibe dinero 24/7 desde cualquier banco sin costo.", systemImage: "bolt.fill")
                    Label("Incluye código QR listo para copiar o compartir.", systemImage: "qrcode")
                }
                .font(.subheadline)
                .symbolRenderingMode(.hierarchical)
            }

            PrimaryButton(title: "Generar mi llave Bre-B", systemImage: "faceid", isLoading: isCreating) {
                Task { await createKey() }
            }
            .disabled(isCreating)

            Label("Te pediremos Face ID para firmar esta operación.", systemImage: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var kycRequired: some View {
        ContentUnavailableView {
            Label("Verifica tu identidad", systemImage: "person.badge.shield.checkmark")
        } description: {
            Text("Para generar tu llave Bre-B necesitamos verificar tu identidad.")
        } actions: {
            PrimaryButton(title: "Verificar identidad", systemImage: "person.badge.shield.checkmark.fill") {
                showKYCSheet = true
            }
            .frame(maxWidth: 260)
        }
        .padding(.top, 40)
    }

    private func createKey() async {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            let key = try await app.api.createBrebKey()
            withAnimation(.snappy) {
                didDeleteKey = false
                store.brebKey = key
            }
            createdCount += 1
        } catch APIError.biometricCancelled {
            // El usuario canceló Face ID voluntariamente.
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func regenerateKey() async {
        isChanging = true
        errorMessage = nil
        defer { isChanging = false }
        do {
            let key = try await app.api.changeBrebKey()
            withAnimation(.snappy) {
                didDeleteKey = false
                store.brebKey = key
            }
            createdCount += 1
        } catch APIError.biometricCancelled {
            // El usuario canceló Face ID voluntariamente.
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func deleteKey() async {
        isDeleting = true
        errorMessage = nil
        defer { isDeleting = false }
        do {
            try await app.api.deleteBrebKey()
            withAnimation(.snappy) {
                store.clearBrebKey()
                didDeleteKey = true
            }
            deletedCount += 1
        } catch APIError.biometricCancelled {
            // El usuario canceló Face ID voluntariamente.
        } catch {
            errorMessage = error.userMessage
        }
    }
}

#Preview("Recibir") {
    ReceiveView()
        .appEnvironment(.preview())
}
