import Foundation
import Security

/// Envoltura mínima del Keychain (genericPassword) para datos sensibles.
/// Todo se guarda con `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: no viaja a backups ni a otros dispositivos.
struct KeychainStore: Sendable {
    enum KeychainError: Error, Sendable {
        case unexpectedStatus(OSStatus)
    }

    let service: String

    init(service: String = "com.cuypay.app") {
        self.service = service
    }

    func data(for account: String) throws -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            return item as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func set(_ data: Data, for account: String) throws {
        let query = baseQuery(account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var addQuery = query
            addQuery.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unexpectedStatus(addStatus) }
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    // MARK: Strings

    func string(for account: String) throws -> String? {
        try data(for: account).flatMap { String(data: $0, encoding: .utf8) }
    }

    func set(_ string: String, for account: String) throws {
        try set(Data(string.utf8), for: account)
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}

/// Cuentas (claves) usadas en el Keychain.
enum KeychainAccount {
    static let refreshToken = "auth.refreshToken"
    static let deviceId = "device.id"
    static let deviceKey = "device.signingKey"
    static let deviceKeyIsSoftware = "device.signingKey.software"
}
