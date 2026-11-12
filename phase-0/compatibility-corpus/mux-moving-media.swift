import AVFoundation
import Foundation

let video = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let audio = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[2]))
let destination = URL(fileURLWithPath: CommandLine.arguments[3])
let composition = AVMutableComposition()
let duration = CMTime(seconds: 3, preferredTimescale: 24)
let range = CMTimeRange(start: .zero, duration: duration)
guard let sourceVideo = video.tracks(withMediaType: .video).first,
      let sourceAudio = audio.tracks(withMediaType: .audio).first,
      let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
else { fatalError("Both source media tracks are required") }
try videoTrack.insertTimeRange(range, of: sourceVideo, at: .zero)
try audioTrack.insertTimeRange(range, of: sourceAudio, at: .zero)
guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
    fatalError("Cannot create passthrough export session")
}
session.outputURL = destination
session.outputFileType = .mov
let finished = DispatchSemaphore(value: 0)
session.exportAsynchronously { finished.signal() }
finished.wait()
guard session.status == .completed else { throw session.error ?? NSError(domain: "FramelineFixture", code: 1) }
