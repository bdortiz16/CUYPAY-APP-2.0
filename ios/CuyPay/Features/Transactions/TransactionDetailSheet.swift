import SwiftUI
import UIKit

/// Hoja de detalle de un movimiento / comprobante oficial de transferencia o recaudo.
struct TransactionDetailSheet: View {
    let transaction: WalletTransaction
    let pocket: Currency
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var copiedRef = false

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                ScrollView {
                    VStack(spacing: 18) {
                        CuyPayVoucherCard(
                            transaction: transaction,
                            pocket: pocket,
                            senderName: app.user?.fullName,
                            copiedReference: copiedRef,
                            onCopyReference: copyReference
                        )
                        .padding(.top, 8)

                        VStack(spacing: 12) {
                            Button {
                                VoucherSharePresenter.shareTransactionVoucher(
                                    transaction,
                                    pocket: pocket,
                                    senderName: app.user?.fullName
                                )
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "square.and.arrow.up")
                                        .font(.body.weight(.semibold))
                                    Text("Compartir comprobante")
                                        .font(.body.weight(.semibold))
                                }
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity)
                                .frame(height: 54)
                                .contentShape(.capsule)
                            }
                            .buttonStyle(.plain)
                            .glassEffect(.regular.interactive(), in: .capsule)

                            PrimaryButton(title: "Listo", systemImage: "checkmark") {
                                dismiss()
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 28)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Comprobante")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func copyReference() {
        UIPasteboard.general.string = transaction.id
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.snappy) { copiedRef = true }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            withAnimation { copiedRef = false }
        }
    }
}
