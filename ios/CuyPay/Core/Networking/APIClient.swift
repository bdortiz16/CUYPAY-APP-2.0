import Foundation

/// Cliente HTTP del backend de CuyPay.
///
/// - JSON camelCase, fechas ISO-8601.
/// - `Authorization: Bearer` con refresh automático (proactivo antes de vencer y reactivo ante 401),
///   con una sola renovación en vuelo a la vez (rotación de refresh token segura).
/// - Operaciones 🔐 firmadas con `RequestSigner` (Secure Enclave + Face ID).
/// - Errores mapeados a `APIError` con los códigos del contrato.
actor APIClient: CuyPayAPI {
    private let baseURL: URL
    private let session: URLSession
    private let tokens: TokenStore
    private let signer: RequestSigner
    private let decoder = JSONCoding.makeDecoder()
    private var refreshTask: Task<Void, any Error>?

    init(baseURL: URL, tokens: TokenStore, deviceSigner: any DeviceSigning, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.tokens = tokens
        self.signer = RequestSigner(signer: deviceSigner)
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 30
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            self.session = URLSession(configuration: configuration)
        }
    }

    // MARK: - Núcleo

    func send<R: Decodable & Sendable>(_ endpoint: Endpoint<R>) async throws -> R {
        try await send(endpoint, allowRefresh: true)
    }

    private func send<R: Decodable & Sendable>(_ endpoint: Endpoint<R>, allowRefresh: Bool) async throws -> R {
        if endpoint.requiresAuth, allowRefresh, await tokens.accessTokenNeedsRefresh() {
            try await refreshSession()
        }

        var request = try makeRequest(for: endpoint)

        if endpoint.requiresAuth {
            guard let accessToken = await tokens.accessToken else { throw APIError.notAuthenticated }
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        if let reason = endpoint.signReason {
            guard let deviceId = await tokens.deviceId else { throw APIError.deviceKeyUnavailable }
            do {
                try await signer.sign(&request, deviceId: deviceId, reason: reason)
            } catch let error as DeviceKeyError {
                throw Self.map(error)
            }
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.network(urlErrorCode: error.code.rawValue)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown("Respuesta no HTTP")
        }

        if (200..<300).contains(http.statusCode) {
            return try decode(R.self, from: data)
        }

        let apiError = Self.parseError(status: http.statusCode, data: data, decoder: decoder)

        // 401 de sesión → renovamos y reintentamos una sola vez.
        // (Si era 🔐, el reintento vuelve a firmar con nonce/timestamp nuevos = nuevo Face ID.)
        if http.statusCode == 401, allowRefresh, endpoint.requiresAuth,
           apiError.code == .unauthorized || apiError.code == .unknown {
            try await refreshSession()
            return try await send(endpoint, allowRefresh: false)
        }

        throw apiError
    }

    private func makeRequest<R>(for endpoint: Endpoint<R>) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.unknown("Base URL inválida")
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + endpoint.path
        if !endpoint.query.isEmpty {
            components.queryItems = endpoint.query.map { URLQueryItem(name: $0.name, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.unknown("URL inválida") }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Locale.preferredLanguages.first ?? "es-CO", forHTTPHeaderField: "Accept-Language")
        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func decode<R: Decodable>(_ type: R.Type, from data: Data) throws -> R {
        if data.isEmpty, let empty = EmptyResponse() as? R {
            return empty
        }
        do {
            return try decoder.decode(R.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    static func parseError(status: Int, data: Data, decoder: JSONDecoder) -> APIError {
        if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
            return .server(status: status, code: envelope.error.code, message: envelope.error.message, limit: envelope.error.details)
        }
        let fallback: APIErrorCode = switch status {
        case 401: .unauthorized
        case 404: .notFound
        case 422: .validationError
        default: .unknown
        }
        return .server(status: status, code: fallback, message: nil, limit: nil)
    }

    private static func map(_ error: DeviceKeyError) -> APIError {
        switch error {
        case .biometryCancelled: .biometricCancelled
        default: .deviceKeyUnavailable
        }
    }

    // MARK: - Refresh (single-flight)

    private func refreshSession() async throws {
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task { try await self.performRefresh() }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    private func performRefresh() async throws {
        guard let refreshToken = await tokens.refreshToken else {
            throw APIError.notAuthenticated
        }
        let endpoint: Endpoint<AuthSession> = try .post("/auth/refresh", body: RefreshRequest(refreshToken: refreshToken), auth: false)
        do {
            let renewed = try await send(endpoint, allowRefresh: false)
            try await tokens.store(renewed)
        } catch let error as APIError {
            if case .server(let status, _, _, _) = error, status == 401 || status == 403 {
                await tokens.clearSession()
                throw APIError.notAuthenticated
            }
            throw error
        }
    }

    // MARK: - Sesión local

    func storedDeviceId() async -> String? { await tokens.deviceId }
    func clearLocalSession() async { await tokens.clearSession() }
    func forgetDevice() async { await tokens.clearAll() }

    // MARK: - Auth

    func requestOTP(phone: String) async throws -> OTPRequestResponse {
        try await send(.post("/auth/otp/request", body: PhoneRequest(phone: phone), auth: false))
    }

    func register(_ request: RegisterRequest) async throws -> AuthSession {
        let session: AuthSession = try await send(.post("/auth/register", body: request, auth: false))
        try await tokens.store(session)
        return session
    }

    func challenge(deviceId: String) async throws -> AuthChallenge {
        try await send(.post("/auth/challenge", body: DeviceIdRequest(deviceId: deviceId), auth: false))
    }

    func login(challengeId: String, deviceId: String, signature: String) async throws -> AuthSession {
        let body = LoginRequest(challengeId: challengeId, deviceId: deviceId, signature: signature)
        let session: AuthSession = try await send(.post("/auth/login", body: body, auth: false))
        try await tokens.store(session)
        return session
    }

    func logout() async throws {
        do {
            let _: EmptyResponse = try await send(.post("/auth/logout"))
        } catch {
            await tokens.clearSession()
            throw error
        }
        await tokens.clearSession()
    }

    func me() async throws -> User {
        try await send(.get("/me"))
    }

    // MARK: - KYC

    func sumsubToken() async throws -> SumsubTokenResponse {
        try await send(.post("/kyc/sumsub/token"))
    }

    func kycStatus() async throws -> KYCStatusResponse {
        try await send(.get("/kyc/status"))
    }

    // MARK: - Bolsillos

    func wallets() async throws -> [Wallet] {
        let response: ItemsResponse<Wallet> = try await send(.get("/wallets"))
        return response.items
    }

    // MARK: - Bre-B

    func brebKey() async throws -> BrebKey? {
        do {
            let key: BrebKey = try await send(.get("/breb/key"))
            return key
        } catch let error as APIError {
            if case .server(404, _, _, _) = error { return nil }
            throw error
        }
    }

    func createBrebKey(preferredAlias: String?) async throws -> BrebKey {
        try await send(.post("/breb/key", body: CreateBrebKeyRequest(preferredAlias: preferredAlias), signReason: SignReason.createBrebKey))
    }

    // MARK: - Beneficiarios

    func resolveAlias(_ alias: String) async throws -> AliasResolution {
        try await send(.post("/beneficiaries/resolve", body: ResolveAliasRequest(alias: alias)))
    }

    func createBeneficiary(resolutionId: String, nickname: String?) async throws -> Beneficiary {
        let body = CreateBeneficiaryRequest(resolutionId: resolutionId, nickname: nickname)
        return try await send(.post("/beneficiaries", body: body, signReason: SignReason.createBeneficiary))
    }

    func beneficiaries() async throws -> [Beneficiary] {
        let response: ItemsResponse<Beneficiary> = try await send(.get("/beneficiaries"))
        return response.items
    }

    func deleteBeneficiary(id: String) async throws {
        let _: EmptyResponse = try await send(.delete("/beneficiaries/\(id)", signReason: SignReason.deleteBeneficiary))
    }

    // MARK: - Envíos

    func transferPreview(beneficiaryId: String, amountMinor: Int64) async throws -> TransferPreview {
        try await send(.post("/transfers/preview", body: TransferPreviewRequest(beneficiaryId: beneficiaryId, amountMinor: amountMinor)))
    }

    func createTransfer(beneficiaryId: String, amountMinor: Int64, description: String?, idempotencyKey: String) async throws -> WalletTransaction {
        let body = CreateTransferRequest(beneficiaryId: beneficiaryId, amountMinor: amountMinor, description: description, idempotencyKey: idempotencyKey)
        return try await send(.post("/transfers", body: body, signReason: SignReason.transfer))
    }

    // MARK: - FX

    func fxRate(from: Currency, to: Currency) async throws -> FxRate {
        let endpoint: Endpoint<FxRate> = .get("/fx/rate", query: [
            .init(name: "from", value: from.code),
            .init(name: "to", value: to.code),
        ])
        return try await send(endpoint)
    }

    func createQuote(from: Currency, to: Currency, amountMinor: Int64) async throws -> Quote {
        try await send(.post("/fx/quotes", body: QuoteRequest(fromCurrency: from, toCurrency: to, amountMinor: amountMinor)))
    }

    func createConversion(quoteId: String, idempotencyKey: String) async throws -> WalletTransaction {
        try await send(.post("/fx/conversions", body: CreateConversionRequest(quoteId: quoteId, idempotencyKey: idempotencyKey), signReason: SignReason.conversion))
    }

    // MARK: - Transacciones

    func transactions(currency: Currency?, limit: Int, cursor: String?) async throws -> TransactionPage {
        var query: [Endpoint<TransactionPage>.QueryItem] = [.init(name: "limit", value: String(limit))]
        if let currency { query.append(.init(name: "currency", value: currency.code)) }
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        return try await send(.get("/transactions", query: query))
    }

    // MARK: - Límites

    func limits() async throws -> LimitsSnapshot {
        try await send(.get("/limits"))
    }

    // MARK: - Dispositivos

    func devices() async throws -> [Device] {
        let response: ItemsResponse<Device> = try await send(.get("/devices"))
        return response.items
    }

    func deleteDevice(id: String) async throws {
        let _: EmptyResponse = try await send(.delete("/devices/\(id)", signReason: SignReason.deleteDevice))
    }
}
