import SwiftUI

/// Gateway host entry + connect. 3-6-9: 1 primary action (Connect).
struct ConnectView: View {
  @EnvironmentObject var link: GatewayLink
  @AppStorage("gateway.host") private var host = ""

  var body: some View {
    VStack(spacing: 8) {
      switch link.phase {
      case .failed(let message):
        Text(message)
          .font(.footnote)
          .foregroundStyle(.red)
          .multilineTextAlignment(.center)
      case .reconnecting:
        Label("Reconnecting…", systemImage: "antenna.radiowaves.left.and.right")
          .font(.footnote)
          .foregroundStyle(.secondary)
      default:
        Image(systemName: "waveform.circle")
          .font(.title2)
          .foregroundStyle(.green)
      }

      TextField("machine host", text: $host)
        .textFieldStyle(.plain)
        .autocorrectionDisabled()

      Button {
        guard !host.isEmpty else { return }
        link.connect(host: host)
      } label: {
        Text("Connect")
          .frame(maxWidth: .infinity)
      }
      .tint(.green)
      .disabled(host.isEmpty)
    }
    .navigationTitle("Osborn")
  }
}
