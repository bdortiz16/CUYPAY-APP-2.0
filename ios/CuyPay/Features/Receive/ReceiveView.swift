import SwiftUI
import UIKit

/// Recibir COP: muestra la llave Bre-B propia (grande, copiar/compartir, QR) o permite crearla (🔐).
struct ReceiveView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    nonisolated static let corporatePrefix = "xatechservic"

    @State private var preferredAlias = ""
    @State private var newAlias = ""
    @State private var isCreating = false
    @State private var isChanging = false
    @State private var isDeleting = false
    @State private var showChangeKey = false
    @State private var showDeleteConfirm = false
    @State private var showKYCSheet = false
    @State private var errorMessage: String?
    @State private var changeKeyError: String?
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
                .scrollDismissesKeyboard(.interactively)
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
            .sheet(isPresented: $showChangeKey) {
                changeKeySheet
            }
            .sheet(isPresented: $showKYCSheet) {
                KYCFlowSheet()
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
                Text("Ya no podrás recibir dinero por Bre-B hasta que crees una nueva llave. Se confirmará con Face ID.")
            }
        }
    }

    // MARK: Hoja para cambiar llave

    private var changeKeySheet: some View {
        let sanitizedChange = Self.sanitizeCustomSuffix(newAlias)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))

        return NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        VStack(spacing: 6) {
                            Text("Cambiar mi llave Bre-B")
                                .font(.system(.title3, design: .serif).weight(.semibold))
                            Text("Escribe el identificador personalizado que quieres usar con el prefijo @\(Self.corporatePrefix). Tu llave anterior se cancelará automáticamente.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 12)

                        aliasInputField(
                            placeholder: "bryan039 o 1019",
                            text: $newAlias
                        )

                        if !sanitizedChange.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: sanitizedChange.count >= 3 ? "sparkles" : "info.circle")
                                    .font(.caption)
                                    .foregroundStyle(sanitizedChange.count >= 3 ? Theme.spruce : .secondary)
                                Text(verbatim: sanitizedChange.count >= 3
                                     ? "Nueva llave: @\(Self.corporatePrefix)\(sanitizedChange)"
                                     : "Escribe al menos 3 letras o números después de @\(Self.corporatePrefix).")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(sanitizedChange.count >= 3 ? Theme.spruce : .secondary)
                                Spacer()
                            }
                            .padding(.horizontal, 4)
                        }

                        if let changeKeyError {
                            ErrorBanner(message: changeKeyError)
                        }

                        PrimaryButton(title: "Confirmar con Face ID", systemImage: "faceid", isLoading: isChanging) {
                            Task { await changeKey() }
                        }
                        .disabled(sanitizedChange.count < 3 || isChanging)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { showChangeKey = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
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
                    changeKeyError = nil
                    newAlias = ""
                    showChangeKey = true
                } label: {
                    Label("Cambiar llave", systemImage: "arrow.triangle.2.circlepath")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.glass)

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
                .disabled(isDeleting)
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
        let sanitizedCreate = Self.sanitizeCustomSuffix(preferredAlias)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))

        return VStack(spacing: 20) {
            if didDeleteKey {
                GlassCard {
                    HStack(spacing: 12) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.spruce)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Llave Bre-B eliminada")
                                .font(.subheadline.weight(.semibold))
                            Text("Crea una nueva llave personalizada abajo o cierra esta ventana.")
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
                .padding(.top, didDeleteKey ? 4 : 20)
            Text("Crea tu llave Bre-B")
                .font(.system(.title, design: .rounded).weight(.bold))
            Text("Con tu llave cualquier persona te puede enviar pesos desde su banco, al instante.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 8) {
                Text("Tu identificador personal")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)

                aliasInputField(
                    placeholder: "bryan039 o 1019",
                    text: $preferredAlias
                )

                if sanitizedCreate.isEmpty {
                    Text(verbatim: "Opcional: escribe de 3 a 16 letras o números después de @\(Self.corporatePrefix) (ej. bryan039 o 1019), o déjalo vacío para asignarte una automática.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if sanitizedCreate.count < 3 {
                    Text(verbatim: "Escribe al menos 3 letras o números después de @\(Self.corporatePrefix).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(verbatim: "Tu llave quedará: @\(Self.corporatePrefix)\(sanitizedCreate)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.spruce)
                }
            }

            PrimaryButton(title: "Crear mi llave Bre-B", systemImage: "faceid", isLoading: isCreating) {
                Task { await createKey() }
            }
            .disabled((!preferredAlias.isEmpty && sanitizedCreate.count < 3) || isCreating)

            Label("Te pediremos Face ID para firmar esta operación.", systemImage: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func aliasInputField(placeholder: String, text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: "@\(Self.corporatePrefix)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Theme.spruce)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Theme.spruce.opacity(0.14), in: .rect(cornerRadius: 10))
                .fixedSize()

            TextField(placeholder, text: Binding(
                get: { text.wrappedValue },
                set: { updated in
                    text.wrappedValue = Self.sanitizeCustomSuffix(updated)
                }
            ))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
        }
        .formFieldStyle()
    }

    nonisolated static func sanitizeCustomSuffix(_ raw: String) -> String {
        var cleaned = raw
            .folding(options: .diacriticInsensitive, locale: nil)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "@", with: "")

        if cleaned.hasPrefix(corporatePrefix), cleaned.count > corporatePrefix.count {
            cleaned = String(cleaned.dropFirst(corporatePrefix.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        } else if cleaned.hasPrefix("xatechseric"), cleaned.count > "xatechseric".count {
            cleaned = String(cleaned.dropFirst("xatechseric".count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }

        let allowed = cleaned.unicodeScalars.filter { scalar in
            (scalar.value >= 97 && scalar.value <= 122) ||
            (scalar.value >= 48 && scalar.value <= 57) ||
            scalar.value == 46
        }
        var result = String(String.UnicodeScalarView(allowed))
        while result.contains("..") {
            result = result.replacingOccurrences(of: "..", with: ".")
        }
        return String(result.prefix(16))
    }

    nonisolated static func formatCorporateAlias(suffix raw: String) -> String? {
        let trimmed = sanitizeCustomSuffix(raw)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !trimmed.isEmpty else { return nil }
        return "@\(corporatePrefix)\(trimmed)"
    }

    private var kycRequired: some View {
        ContentUnavailableView {
            Label("Verifica tu identidad", systemImage: "person.badge.shield.checkmark")
        } description: {
            Text("Para crear tu llave Bre-B necesitamos verificar tu identidad.")
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
        let formatted = Self.formatCorporateAlias(suffix: preferredAlias)
        do {
            let key = try await app.api.createBrebKey(preferredAlias: formatted)
            withAnimation(.snappy) {
                didDeleteKey = false
                preferredAlias = ""
                store.brebKey = key
            }
            createdCount += 1
        } catch APIError.biometricCancelled {
            // El usuario canceló Face ID voluntariamente.
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func changeKey() async {
        isChanging = true
        changeKeyError = nil
        errorMessage = nil
        defer { isChanging = false }
        guard let formatted = Self.formatCorporateAlias(suffix: newAlias),
              formatted.count >= Self.corporatePrefix.count + 4 else {
            changeKeyError = String(localized: "Escribe al menos 3 letras o números después de @xatechservic.")
            return
        }
        do {
            let key = try await app.api.changeBrebKey(preferredAlias: formatted)
            withAnimation(.snappy) {
                didDeleteKey = false
                store.brebKey = key
                showChangeKey = false
            }
            createdCount += 1
        } catch APIError.biometricCancelled {
            // El usuario canceló Face ID voluntariamente.
        } catch {
            changeKeyError = error.userMessage
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
                showChangeKey = false
                preferredAlias = ""
                newAlias = ""
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
