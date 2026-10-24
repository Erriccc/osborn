import Foundation
import Network

/// WebSocket link to the on-machine watch gateway (agent/src/watch-gateway.ts).
///
/// Reconnect follows the TN3135 pattern: exponential backoff 1s→30s with
/// ±20% jitter, unlimited attempts, immediate retry on user-initiated connect.
@MainActor
final class GatewayLink: ObservableObject {
  enum Phase: Equatable {
    case idle
    case connecting
    case joined(room: String)
    case reconnecting
    case failed(String)
  }

  enum AgentState: String {
    case idle, listening, thinking, speaking
  }

  struct Question: Identifiable {
    let id: String
    let text: String
  }

  @Published var phase: Phase = .idle
  @Published var agentState: AgentState = .idle
  @Published var question: Question?
  @Published var micOn = false
  @Published var speakerOn = true

  private(set) var host: String = ""
  private var conn: NWConnection?
  private let workQueue = DispatchQueue(label: "osborn.watch.gateway")
  private var backoff: Double = 1
  private var wantsConnection = false
  private let audio = AudioPipe()

  // MARK: - Connection lifecycle

  func connect(host: String) {
    self.host = host
    wantsConnection = true
    backoff = 1
    open()
  }

  func end() {
    wantsConnection = false
    setMic(false)
    audio.stopDownlink()
    conn?.cancel()
    conn = nil
    phase = .idle
  }

  private func open() {
    phase = .connecting
    let useTLS = host.contains("://https") == false && (host.hasPrefix("https") || host.hasPrefix("wss"))
    var target = host
    for prefix in ["wss://", "ws://", "https://", "http://"] {
      if target.hasPrefix(prefix) { target = String(target.dropFirst(prefix.count)) }
    }
    // Gateway default port mirrors WATCH_GATEWAY_PORT (8742).
    if !target.contains(":") { target += ":8742" }

    let params = NWParameters.tcp
    let wsOptions = NWProtocolWebSocket.Options()
    wsOptions.autoReplyPing = true
    if useTLS {
      let tls = NWProtocolTLS.Options()
      params.defaultProtocolStack.applicationProtocols.insert(tls, at: 0)
      // NOTE(scaffold): ATS-grade cert validation left as default; production
      // should pin the machine cert or use a signed hostname.
    }
    params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

    guard let urlHost = target.split(separator: ":").first.map(String.init),
          let urlPort = UInt16(target.split(separator: ":").last ?? "8742")
    else {
      phase = .failed("bad host")
      return
    }
    let connection = NWConnection(
      host: NWEndpoint.Host(urlHost),
      port: NWEndpoint.Port(rawValue: urlPort) ?? 8742,
      using: params
    )
    conn = connection

    connection.stateUpdateHandler = { [weak self] state in
      Task { @MainActor [weak self] in self?.handleState(state) }
    }
    receiveLoop(on: connection)
    connection.start(queue: workQueue)
  }

  private func handleState(_ state: NWConnection.State) {
    switch state {
    case .ready:
      backoff = 1
      phase = .connecting // joined only after the server confirms hello
      send(["type": "hello", "watchId": WatchIdentity.id])
    case .failed, .cancelled:
      setMic(false)
      audio.stopDownlink()
      conn = nil
      guard wantsConnection else { return }
      phase = .reconnecting
      let delay = backoff * Double.random(in: 0.8...1.2)
      backoff = min(backoff * 2, 30)
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self, self.wantsConnection else { return }
        self.open()
      }
    default:
      break
    }
  }

  // MARK: - Frames

  private func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let connection = conn
    else { return }
    sendWS(data, opcode: .text, on: connection)
  }

  private func sendBinary(_ data: Data) {
    guard let connection = conn else { return }
    sendWS(data, opcode: .binary, on: connection)
  }

  private func sendWS(_ data: Data, opcode: NWProtocolWebSocket.Metadata.Opcode, on connection: NWConnection) {
    let meta = NWProtocolWebSocket.Metadata()
    meta.opcode = opcode
    let context = NWConnection.ContentContext(identifier: opcode == .text ? "json" : "pcm", metadata: [meta])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
  }

  private func receiveLoop(on connection: NWConnection) {
    connection.receiveMessage { [weak self] data, context, _, error in
      Task { @MainActor [weak self] in
        guard let self else { return }
        if let data, !data.isEmpty {
          let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
          switch meta?.opcode {
          case .binary:
            self.audio.feedDownlink(data)
          case .text, .none, .some(.pong):
            self.handleText(data)
          default:
            break
          }
        }
        if error == nil {
          self.receiveLoop(on: connection)
        }
      }
    }
  }

  private func handleText(_ data: Data) {
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let type = obj["type"] as? String
    else { return }
    switch type {
    case "joined":
      if let room = obj["room"] as? String { phase = .joined(room: room) }
    case "state":
      if let agent = obj["agent"] as? String { agentState = AgentState(rawValue: agent) ?? .idle }
    case "audio":
      audio.startDownlink()
    case "question":
      question = Question(
        id: (obj["qid"] as? String) ?? "perm",
        text: (obj["text"] as? String) ?? "Allow?"
      )
    case "error":
      if let message = obj["message"] as? String { phase = .failed(message) }
    default:
      break
    }
  }

  // MARK: - Controls (LiveView surface — keep to the 3-6-9 rule: 3 actions)

  func toggleMic() {
    setMic(!micOn)
  }

  private func setMic(_ on: Bool) {
    guard micOn != on else { return }
    micOn = on
    if on {
      audio.onUplinkFrame = { [weak self] frame in
        Task { @MainActor [weak self] in self?.sendBinary(frame) }
      }
      audio.startCapture()
    } else {
      audio.onUplinkFrame = nil
      audio.stopCapture()
    }
  }

  func toggleSpeaker() {
    speakerOn.toggle()
    audio.setMuted(!speakerOn)
  }

  /// Question sheet response — rides the room data channel as a
  /// permission_response, same shape the web UI sends.
  func answer(_ allow: Bool) {
    if let q = question {
      send(["type": "answer", "qid": q.id, "allow": allow])
    }
    question = nil
  }
}

/// Stable per-install watch identifier (gateway labels the published track).
enum WatchIdentity {
  static let id: String = {
    if let stored = UserDefaults.standard.string(forKey: "watch.id") { return stored }
    let fresh = UUID().uuidString.prefix(8).lowercased()
    UserDefaults.standard.set(String(fresh), forKey: "watch.id")
    return String(fresh)
  }()
}
