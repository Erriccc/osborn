import SwiftUI

/// Live glance + voice surface. 3-6-9 rule: exactly 3 primary actions —
/// Talk (press-to-toggle mic), Mute (speaker), End. Blocking questions arrive
/// as a full-screen sheet (QuestionView) on top, not as a 4th control.
struct LiveView: View {
  @EnvironmentObject var link: GatewayLink

  private var stateColor: Color {
    switch link.agentState {
    case .listening: return .green
    case .thinking: return .yellow
    case .speaking: return .blue
    case .idle: return .gray
    }
  }

  var body: some View {
    VStack(spacing: 6) {
      Circle()
        .fill(stateColor)
        .frame(width: 18, height: 18)
        .opacity(link.agentState == .idle ? 0.35 : 1)
      Text(link.agentState.rawValue.capitalized)
        .font(.headline)

      Button {
        link.toggleMic()
      } label: {
        Label(link.micOn ? "Listening…" : "Talk", systemImage: link.micOn ? "mic.fill" : "mic")
          .frame(maxWidth: .infinity)
      }
      .tint(.green)

      Button {
        link.toggleSpeaker()
      } label: {
        Label(link.speakerOn ? "Mute" : "Muted", systemImage: link.speakerOn ? "speaker.wave.2" : "speaker.slash")
          .frame(maxWidth: .infinity)
      }
      .tint(.orange)

      Button(role: .destructive) {
        link.end()
      } label: {
        Label("End", systemImage: "phone.down")
          .frame(maxWidth: .infinity)
      }
    }
    .navigationTitle("Osborn")
    .sheet(item: $link.question) { question in
      QuestionView(question: question)
        .environmentObject(link)
    }
  }
}
