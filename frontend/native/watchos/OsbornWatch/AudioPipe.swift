import AVFoundation

/// Mic capture + playback for the watch, at the gateway's wire rate:
/// 24kHz mono Int16LE PCM on BOTH directions (the gateway resamples to/from
/// the room's 48kHz).
///
/// Uplink: AVAudioEngine input tap → AVAudioConverter 24k Float32→Int16 →
///         binary WS frames (onUplinkFrame).
/// Downlink: WS binary frames → ring buffer → AVAudioSourceNode render pull.
///
/// Scaffold note: validated at compile time against the watchOS Simulator
/// SDK; on-device timing (buffer sizes vs. WT transmission limits) is tuned
/// when TestFlight access lands.
final class AudioPipe {
  static let wireRate: Double = 24_000

  /// Called on the audio thread's queue with a ready-to-send binary chunk.
  var onUplinkFrame: ((Data) -> Void)?

  private let engine = AVAudioEngine()
  private let wireFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: AudioPipe.wireRate,
    channels: 1,
    interleaved: true
  )
  private var converter: AVAudioConverter?
  private var downRing = DownRing(capacityFrames: 24_000 * 2) // 2s at wire rate
  private var downNode: AVAudioSourceNode?
  private var captureRunning = false
  private var downlinkRunning = false
  private var muted = false

  init() {}

  // MARK: - Session

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
    try session.setPreferredSampleRate(AudioPipe.wireRate)
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)
  }

  // MARK: - Uplink (mic)

  func startCapture() {
    guard !captureRunning else { return }
    do {
      try activateSession()
      let input = engine.inputNode
      let inFormat = input.outputFormat(forBus: 0)
      converter = AVAudioConverter(from: inFormat, to: wireFormat!)

      input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
        self?.convertAndSend(buffer)
      }
      try engine.start()
      captureRunning = true
    } catch {
      NSLog("AudioPipe capture failed: \(error.localizedDescription)")
    }
  }

  func stopCapture() {
    guard captureRunning else { return }
    engine.inputNode.removeTap(onBus: 0)
    captureRunning = false
  }

  private func convertAndSend(_ buffer: AVAudioPCMBuffer) {
    guard let converter, let wireFormat else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * AudioPipe.wireRate / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }

    var error: NSError?
    var consumed = false
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if let error {
      NSLog("AudioPipe convert error: \(error.localizedDescription)")
      return
    }
    guard out.frameLength > 0, let channel = out.int16ChannelData?[0] else { return }
    let count = Int(out.frameLength)
    var data = Data(capacity: count * 2)
    data.append(contentsOf: UnsafeBufferPointer(start: channel, count: count))
    onUplinkFrame?(data)
  }

  // MARK: - Downlink (agent audio)

  func startDownlink() {
    guard !downlinkRunning else { return }
    do {
      try activateSession()
      let source = AVAudioSourceNode(format: wireFormat) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
        guard let self else { return noErr }
        let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
        self.downRing.read(into: ablPointer, frameCount: frameCount)
        return noErr
      }
      engine.attach(source)
      engine.connect(source, to: engine.mainMixerNode, format: wireFormat)
      downNode = source
      if !engine.isRunning { try engine.start() }
      downlinkRunning = true
    } catch {
      NSLog("AudioPipe downlink failed: \(error.localizedDescription)")
    }
  }

  func stopDownlink() {
    guard downlinkRunning, let node = downNode else { return }
    engine.disconnectNodeOutput(node)
    downRing.reset()
    downlinkRunning = false
  }

  func setMuted(_ on: Bool) {
    muted = on
    engine.mainMixerNode.outputVolume = on ? 0 : 1
  }

  /// Feed a WS binary payload (Int16LE PCM @24k mono) into the playback ring.
  func feedDownlink(_ data: Data) {
    guard downlinkRunning, !muted, !data.isEmpty else { return }
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let int16s = raw.bindMemory(to: Int16.self)
      downRing.write(int16s)
    }
  }
}

/// Lock-free-ish ring buffer for downlink PCM. Single writer (WS receive),
/// single reader (render thread); a torn frame worst-case drops to silence —
/// acceptable for voice.
private final class DownRing {
  private let buffer: [Int16]
  private var writeIdx = 0
  private var readIdx = 0
  private let lock = NSLock()

  init(capacityFrames: Int) {
    buffer = [Int16](repeating: 0, count: capacityFrames)
  }

  var available: Int {
    lock.lock(); defer { lock.unlock() }
    return (writeIdx - readIdx + buffer.count) % buffer.count
  }

  func write(_ frames: UnsafeBufferPointer<Int16>) {
    lock.lock(); defer { lock.unlock() }
    for frame in frames {
      buffer[writeIdx] = frame
      writeIdx = (writeIdx + 1) % buffer.count
      if writeIdx == readIdx { readIdx = (readIdx + 1) % buffer.count } // overwrite oldest
    }
  }

  func read(into abl: UnsafeMutableAudioBufferListPointer, frameCount: AVAudioFrameCount) {
    lock.lock(); defer { lock.unlock() }
    for bufIdx in 0..<abl.count {
      guard let data = abl[bufIdx].mData else { continue }
      let dst = data.assumingMemoryBound(to: Int16.self)
      for i in 0..<Int(frameCount) {
        if readIdx == writeIdx {
          dst[i] = 0 // underrun → silence
        } else {
          dst[i] = buffer[readIdx]
          readIdx = (readIdx + 1) % buffer.count
        }
      }
    }
  }

  func reset() {
    lock.lock(); defer { lock.unlock() }
    writeIdx = 0
    readIdx = 0
  }
}
