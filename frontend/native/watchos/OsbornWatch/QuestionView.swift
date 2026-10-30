import SwiftUI

/// Blocking-question sheet: 2 actions (Yes / No). Answers ride the room data
/// channel as permission_response — the agent treats them exactly like web-UI
/// permission answers.
struct QuestionView: View {
  @EnvironmentObject var link: GatewayLink
  let question: GatewayLink.Question

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "questionmark.circle")
        .font(.title3)
        .foregroundStyle(.yellow)
      Text(question.text)
        .font(.footnote)
        .multilineTextAlignment(.center)
        .lineLimit(6)

      Button {
        link.answer(true)
      } label: {
        Text("Yes")
          .frame(maxWidth: .infinity)
      }
      .tint(.green)

      Button {
        link.answer(false)
      } label: {
        Text("No")
          .frame(maxWidth: .infinity)
      }
      .tint(.red)
    }
    .interactiveDismissDisabled()
  }
}
