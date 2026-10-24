import SwiftUI

/// Osborn Watch — Track 2 native watchOS surface (scaffold).
///
/// Architecture: no WKWebView on watchOS and LiveKit's Swift SDK will never
/// target it, so this app speaks a small WebSocket protocol (GatewayLink) to
/// the on-machine gateway (agent/src/watch-gateway.ts), which bridges into the
/// user's LiveKit room:
///   uplink   mic PCM 24kHz Int16LE (binary WS frames)
///   downlink agent audio 24kHz Int16LE (binary WS frames)
///   control  JSON text frames (hello/joined/state/question/answer/ping)
///
/// 3-6-9 rule: Connect screen = 1 action · Live screen = 3 (Talk, Mute, End)
/// · question sheet = 2 (Yes / No).
@main
struct OsbornWatchApp: App {
  @StateObject private var link = GatewayLink()

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        RootView()
          .environmentObject(link)
      }
    }
  }
}

struct RootView: View {
  @EnvironmentObject var link: GatewayLink

  var body: some View {
    switch link.phase {
    case .idle, .failed, .reconnecting:
      ConnectView()
    case .connecting:
      ProgressView("Connecting…")
    case .joined:
      LiveView()
    }
  }
}
