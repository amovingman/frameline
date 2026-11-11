import AVFoundation
import CoreVideo
import Foundation

let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let writer = try AVAssetWriter(outputURL: destination, fileType: .mov)
let width = 320
let height = 180
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.jpeg,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
guard writer.canAdd(input) else { fatalError("Cannot add video input") }
writer.add(input)
guard writer.startWriting() else { throw writer.error ?? NSError(domain: "FramelineFixture", code: 1) }
writer.startSession(atSourceTime: .zero)

for frame in 0..<72 {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
    guard status == kCVReturnSuccess, let pixelBuffer = buffer else { fatalError("Cannot allocate frame") }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let bytes = CVPixelBufferGetBaseAddress(pixelBuffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
    for y in 0..<height {
        for x in 0..<width {
            let offset = y * stride + x * 4
            let movingBar = abs(x - (frame * 4 % width)) < 14
            bytes[offset] = movingBar ? 240 : UInt8(40 + y / 3) // B
            bytes[offset + 1] = movingBar ? 240 : UInt8(55 + x / 6) // G
            bytes[offset + 2] = movingBar ? 240 : UInt8(80 + frame / 2) // R
            bytes[offset + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.01) }
    let time = CMTime(value: CMTimeValue(frame), timescale: 24)
    guard adaptor.append(pixelBuffer, withPresentationTime: time) else { throw writer.error ?? NSError(domain: "FramelineFixture", code: 2) }
}
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { throw writer.error ?? NSError(domain: "FramelineFixture", code: 3) }
