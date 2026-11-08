import SwiftUI

// MARK: - Lista

struct BeneficiariesView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @State private var showAdd = false
    @State private var sendTo: Beneficiary?
    @State private var pendingDelete: Beneficiary?
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            BrandBackground()
            List {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                ForEach(store.beneficiaries) { beneficiary in
                    Button {
                        if beneficiary.status == .active { sendTo = beneficiary }
                    } label: {
                        BeneficiaryRow(beneficiary: beneficiary)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            pendingDelete = beneficiary
                        } label: {
                            Label("Eliminar", systemImage: "trash")
                        }
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))
                }
            }
            .scrollContentBackground(.hidden)
            .refreshable { await store.refreshBeneficiaries() }
            .overlay {
                if store.beneficiaries.isEmpty {
                    ContentUnavailableView {
                        Label("Sin beneficiarios", systemImage: "person.2")
                    } description: {
                        Text("Inscribe la llave Bre-B de las personas a las que les envías dinero.")
                    } actions: {
                        Button("Agregar beneficiario") { showAdd = true }
                            .buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .navigationTitle("Beneficiarios")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAdd = true
                } label: {
                    Label("Agregar", systemImage: "plus")
                }
                .disabled(!app.isKYCApproved)
            }
        }
        .sheet(isPresented: $showAdd) {
            AddBeneficiaryFlowView()
        }
        .sheet(item: $sendTo) { beneficiary in
            SendFlowView(preselected: beneficiary)
        }
        .confirmationDialog(
            "¿Eliminar beneficiario?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { beneficiary in
            Button("Eliminar a \(beneficiary.displayName)", role: .destructive) {
                Task { await delete(beneficiary) }
            }
        } message: { _ in
            Text("Te pediremos Face ID para confirmar.")
        }
        .task { await store.refreshBeneficiaries() }
    }

    private func delete(_ beneficiary: Beneficiary) async {
        errorMessage = nil
        do {
            try await app.api.deleteBeneficiary(id: beneficiary.id)
            await store.refreshBeneficiaries()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

// MARK: - Agregar (flujo)

struct AddBeneficiaryFlowView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: AddBeneficiaryModel?
    private let onComplete: ((Beneficiary) -> Void)?

    init(onComplete: ((Beneficiary) -> Void)? = nil) {
        self.onComplete = onComplete
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                if let model {
                    AddBeneficiaryContent(model: model, onFinish: finish)
                }
            }
            .navigationTitle("Nuevo beneficiario")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .interactiveDismissDisabled(isBusy)
        .onAppear {
            if model == nil { model = AddBeneficiaryModel(api: app.api) }
        }
    }

    private var isBusy: Bool {
        if case .verifying = model?.phase { return true }
        return false
    }

    private func finish(_ beneficiary: Beneficiary?) {
        dismiss()
        if let beneficiary { onComplete?(beneficiary) }
    }
}

private struct AddBeneficiaryContent: View {
    @Environment(WalletStore.self) private var store
    @Bindable var model: AddBeneficiaryModel
    let onFinish: (Beneficiary?) -> Void
    @FocusState private var keyFocused: Bool

    var body: some View {
        Group {
            switch model.phase {
            case .enterKey:
                enterKey
            case .resolving:
                resolving
            case .confirm(let resolution):
                confirm(resolution)
            case .verifying:
                AMLVerificationProgressView()
            case .done(let outcome):
                result(outcome)
            }
        }
        .animation(.smooth, value: model.phase)
        .sensoryFeedback(trigger: model.phase) { _, newPhase in
            switch newPhase {
            case .done(.active): .success
            case .done(.pendingReview): .warning
            case .done(.rejected): .error
            case .confirm: .selection
            default: nil
            }
        }
    }

    // MARK: Paso 1 — llave

    private var enterKey: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Ingresa la llave Bre-B")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                Text("Puede ser un celular, una cédula, un correo o un alias como @juan.")
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 8) {
                    TextField("3001234567, @alias, correo…", text: $model.alias)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .focused($keyFocused)
                        .submitLabel(.search)
                        .onSubmit { Task { await model.resolve() } }
                        .formFieldStyle()
                    if !model.alias.isEmpty {
                        Label(model.keyKind.title, systemImage: model.keyKind.systemImage)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(model.keyKind == .invalid ? Theme.negative : Theme.spruce)
                            .transition(.opacity)
                    }
                }

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: "Consultar llave", systemImage: "magnifyingglass", isEnabled: model.keyKind != .invalid) {
                Task { await model.resolve() }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .onAppear { keyFocused = true }
    }

    // MARK: Paso 2 — consultando

    private var resolving: some View {
        VStack(spacing: 18) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text("Consultando llave…")
                .font(.headline)
            Text("Estamos buscando al titular en el directorio Bre-B.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
    }

    // MARK: Paso 3 — confirmar titular

    private func confirm(_ resolution: AliasResolution) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("¿Es la persona correcta?")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(spacing: 14) {
                    AvatarView(initials: initials(resolution.holderNameFull), size: 64, seed: resolution.alias)
                    Text(verbatim: resolution.holderName)
                        .font(.title3.weight(.bold))
                        .multilineTextAlignment(.center)
                    StatusBadge(text: "Titular verificado en Bre-B", color: Theme.spruce, systemImage: "checkmark.seal.fill")
                    Divider()
                    DetailRow(title: "Llave", value: resolution.alias)
                    DetailRow(title: "Banco", value: resolution.bankName)
                    DetailRow(title: "Documento", value: "\(resolution.documentType) \(resolution.documentMasked)")
                }
                .padding(20)
                .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))

                TextField("Apodo (opcional), ej. Mamá", text: $model.nickname)
                    .formFieldStyle()

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }

                Label("Al inscribirlo validaremos al titular en listas de control (AML), como exige la regulación.", systemImage: "checkmark.shield")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                PrimaryButton(title: "Confirmar e inscribir", systemImage: "faceid") {
                    Task { await model.confirm(resolution, store: store) }
                }
                Button("No es esta persona") { model.restart() }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
    }

    // MARK: Paso 5 — resultado

    @ViewBuilder
    private func result(_ outcome: AddBeneficiaryModel.Outcome) -> some View {
        VStack(spacing: 18) {
            Spacer()
            switch outcome {
            case .active(let beneficiary):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 88))
                    .foregroundStyle(Theme.positive)
                    .symbolEffect(.bounce, value: beneficiary.id)
                Text("¡Beneficiario inscrito!")
                    .font(.system(.title, design: .rounded).weight(.bold))
                Text("Ya puedes enviarle dinero a \(beneficiary.displayName) por Bre-B.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Spacer()
                PrimaryButton(title: "Enviar dinero ahora", systemImage: "paperplane.fill") { onFinish(beneficiary) }
                SecondaryButton(title: "Listo") { onFinish(nil) }
            case .pendingReview:
                Image(systemName: "clock.badge.checkmark")
                    .font(.system(size: 80, weight: .light))
                    .foregroundStyle(Theme.warning)
                Text("Inscripción en revisión")
                    .font(.system(.title, design: .rounded).weight(.bold))
                Text("Nuestro equipo de cumplimiento revisará la información. Te avisaremos cuando el beneficiario esté activo, normalmente en menos de 24 horas hábiles.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Spacer()
                PrimaryButton(title: "Entendido") { onFinish(nil) }
            case .rejected:
                Image(systemName: "person.crop.circle.badge.xmark")
                    .font(.system(size: 80, weight: .light))
                    .foregroundStyle(.secondary)
                Text("No pudimos completar la inscripción")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                    .multilineTextAlignment(.center)
                Text("En este momento no es posible inscribir esta cuenta como beneficiario. Si tienes preguntas, escríbenos a soporte@cuypay.com.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Spacer()
                SecondaryButton(title: "Volver") { onFinish(nil) }
            }
        }
        .padding(24)
    }

    private func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

// MARK: - Paso 4 — verificación AML (progreso)

struct AMLVerificationProgressView: View {
    @State private var completedSteps = 0

    private let steps: [LocalizedStringKey] = [
        "Validando titular de la llave",
        "Verificación en listas de control (AML)",
        "Registrando cuenta destino",
    ]

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "checkmark.shield")
                .font(.system(size: 72, weight: .light))
                .foregroundStyle(Theme.spruce)
                .symbolEffect(.pulse, options: .repeating)
            Text("Verificación AML")
                .font(.system(.title2, design: .rounded).weight(.bold))
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, title in
                    HStack(spacing: 12) {
                        ZStack {
                            if index < completedSteps {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Theme.positive)
                                    .transition(.scale.combined(with: .opacity))
                            } else if index == completedSteps {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "circle")
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .frame(width: 24, height: 24)
                        Text(title)
                            .font(.subheadline)
                            .foregroundStyle(index <= completedSteps ? .primary : .secondary)
                    }
                }
            }
            .padding(20)
            .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
            Text("Esto puede tardar unos segundos.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .task {
            // Progreso visual mientras el backend responde (el último paso queda activo hasta el final).
            for step in 1..<steps.count {
                try? await Task.sleep(for: .milliseconds(900))
                withAnimation(.snappy) { completedSteps = step }
            }
        }
    }
}

#Preview("Beneficiarios") {
    NavigationStack {
        BeneficiariesView()
    }
    .appEnvironment(.preview())
}

#Preview("Agregar beneficiario") {
    AddBeneficiaryFlowView()
        .appEnvironment(.preview())
}
