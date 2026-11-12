import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Firma con la clave del dispositivo. Implementado por `SecureEnclaveKeyManager` (producción)
/// y `SoftwareSigningKey` (tests / simulador en DEBUG).
protocol DeviceSigning: Sendable {
    /// ¿Ya existe una clave para este dispositivo?
    func hasKey() -> Bool
    /// Crea (o reemplaza) la clave del dispositivo y devuelve la pública en X9.63 base64 (65 bytes sin comprimir).
    func createKey() async throws -> String
    /// Clave pública X9.63 base64 de la clave existente.
    func publicKeyBase64() throws -> String
    /// Firma ECDSA-SHA256 de `message`. Devuelve la firma **DER** en base64.
    /// En el Secure Enclave esto exige Face ID (`reason` se muestra en el diálogo).
    func sign(_ message: Data, reason: String) async throws -> String
    /// Elimina la clave (cerrar sesión definitivo / re-enrolamiento).
    func deleteKey() throws
}

enum DeviceKeyError: Error, Sendable {
    case secureEnclaveUnavailable
    case keyNotFound
    case accessControlCreationFailed
    case biometryUnavailable
    case biometryCancelled
    case biometryFailed
    case keyInvalidated
}

/// Gestiona el par P-256 del Secure Enclave.
///
/// - La clave se crea con `[.privateKeyUsage, .biometryCurrentSet]` y `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`:
///   cada firma exige Face ID y si el usuario cambia sus biometrías, la clave queda inválida.
/// - En el Keychain solo guardamos `dataRepresentation`, que es un blob cifrado que únicamente
///   el Secure Enclave de **este** dispositivo puede usar.
/// - Simulador: si el Secure Enclave no está disponible usamos una clave P-256 por software
///   **solo en DEBUG** (con advertencia en consola). En Release se lanza `secureEnclaveUnavailable`.
///
/// No guarda estado mutable: es `Sendable` y sus métodos `async` corren fuera del hilo principal,
/// así la firma (que espera a Face ID) nunca bloquea la UI.
final class SecureEnclaveKeyManager: DeviceSigning {
    private let keychain: KeychainStore

    init(keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
    }

    /// ¿Estamos usando la clave por software (solo DEBUG / simulador)?
    var isUsingSoftwareFallback: Bool {
        (try? keychain.string(for: KeychainAccount.deviceKeyIsSoftware)) == "1"
    }

    static var isSecureEnclaveAvailable: Bool { SecureEnclave.isAvailable }

    func hasKey() -> Bool {
        ((try? keychain.data(for: KeychainAccount.deviceKey)) ?? nil) != nil
    }

    func createKey() async throws -> String {
        try deleteKey()

        if SecureEnclave.isAvailable {
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                [.privateKeyUsage, .biometryCurrentSet],
                &error
            ) else {
                throw DeviceKeyError.accessControlCreationFailed
            }
            let context = LAContext()
            context.localizedReason = String(localized: "Activa Face ID para proteger tu cuenta CuyPay")
            let key = try SecureEnclave.P256.Signing.PrivateKey(
                compactRepresentable: false,
                accessControl: access,
                authenticationContext: context
            )
            try keychain.set(key.dataRepresentation, for: KeychainAccount.deviceKey)
            try keychain.delete(KeychainAccount.deviceKeyIsSoftware)
            return key.publicKey.x963Representation.base64EncodedString()
        }

        #if DEBUG
        print("⚠️ [CuyPay] Secure Enclave no disponible (¿simulador?). Usando clave P-256 POR SOFTWARE. Solo para desarrollo.")
        let key = P256.Signing.PrivateKey(compactRepresentable: false)
        try keychain.set(key.rawRepresentation, for: KeychainAccount.deviceKey)
        try keychain.set("1", for: KeychainAccount.deviceKeyIsSoftware)
        return key.publicKey.x963Representation.base64EncodedString()
        #else
        throw DeviceKeyError.secureEnclaveUnavailable
        #endif
    }

    func publicKeyBase64() throws -> String {
        guard let data = try keychain.data(for: KeychainAccount.deviceKey) else {
            throw DeviceKeyError.keyNotFound
        }
        if isUsingSoftwareFallback {
            #if DEBUG
            let key = try P256.Signing.PrivateKey(rawRepresentation: data)
            return key.publicKey.x963Representation.base64EncodedString()
            #else
            throw DeviceKeyError.secureEnclaveUnavailable
            #endif
        }
        // Cargar la clave sin contexto autenticado no dispara Face ID: solo leemos la pública.
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
        return key.publicKey.x963Representation.base64EncodedString()
    }

    func sign(_ message: Data, reason: String) async throws -> String {
        let data: Data
        do {
            guard let stored = try keychain.data(for: KeychainAccount.deviceKey) else {
                throw DeviceKeyError.keyNotFound
            }
            data = stored
        } catch let error as DeviceKeyError {
            throw error
        } catch {
            throw DeviceKeyError.keyNotFound
        }

        if isUsingSoftwareFallback {
            #if DEBUG
            let key = try P256.Signing.PrivateKey(rawRepresentation: data)
            let signature = try key.signature(for: message)
            return signature.derRepresentation.base64EncodedString()
            #else
            throw DeviceKeyError.secureEnclaveUnavailable
            #endif
        }

        // 1) Evaluamos Face ID de forma asíncrona (no bloquea el hilo principal).
        let context = LAContext()
        context.localizedReason = reason
        context.localizedFallbackTitle = "" // sin "Ingresar código": la clave exige biometría.
        do {
            _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch let error as LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback:
                throw DeviceKeyError.biometryCancelled
            case .authenticationFailed:
                throw DeviceKeyError.biometryFailed
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
                throw DeviceKeyError.biometryUnavailable
            default:
                throw DeviceKeyError.biometryFailed
            }
        } catch let error as DeviceKeyError {
            throw error
        } catch {
            throw DeviceKeyError.biometryFailed
        }

        // 2) Usamos el contexto ya autenticado: el Secure Enclave no vuelve a pedir Face ID.
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: data,
                authenticationContext: context
            )
            let signature = try key.signature(for: message)
            return signature.derRepresentation.base64EncodedString()
        } catch {
            // Si las biometrías cambiaron (`.biometryCurrentSet`), la clave queda inutilizable.
            throw DeviceKeyError.keyInvalidated
        }
    }

    func deleteKey() throws {
        try keychain.delete(KeychainAccount.deviceKey)
        try keychain.delete(KeychainAccount.deviceKeyIsSoftware)
    }
}

/// Clave P-256 por software, en memoria. Para tests unitarios y previews (no usa Face ID).
/// Guarda solo `rawRepresentation` (Data, `Sendable`) y reconstruye la clave en cada uso.
final class SoftwareSigningKey: DeviceSigning {
    private let rawKey: Data

    init(rawRepresentation: Data? = nil) {
        self.rawKey = rawRepresentation ?? P256.Signing.PrivateKey(compactRepresentable: false).rawRepresentation
    }

    private var key: P256.Signing.PrivateKey {
        // `rawKey` siempre proviene de una clave válida, por eso el `try!` es seguro.
        // swiftlint:disable:next force_try
        try! P256.Signing.PrivateKey(rawRepresentation: rawKey)
    }

    var publicKey: P256.Signing.PublicKey { key.publicKey }

    func hasKey() -> Bool { true }
    func createKey() async throws -> String { try publicKeyBase64() }
    func publicKeyBase64() throws -> String { key.publicKey.x963Representation.base64EncodedString() }
    func sign(_ message: Data, reason: String) async throws -> String {
        try key.signature(for: message).derRepresentation.base64EncodedString()
    }
    func deleteKey() throws {}
}
