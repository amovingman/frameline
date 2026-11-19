import Foundation
import AVFoundation
import AppKit
import ImageIO
import UniformTypeIdentifiers

// A crashed desktop must not leave an encoder running after a replacement
// queue acquires the metadata lock. Keep this source alive for the CLI lifetime.
let parentPID = getppid()
guard parentPID > 1 else { exit(1) }
let parentExit = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: .global())
parentExit.setEventHandler { _exit(1) }
parentExit.resume()
guard getppid() == parentPID else { exit(1) }

enum MediaFailure: Error { case invalid, unavailable, unsupported, output, tooLarge }
let imageExtensions: Set<String> = ["png", "jpg", "jpeg"]
let videoExtensions: Set<String> = ["mov", "mp4", "m4v"]
func integer(_ value: Any?, _ fallback: Int, _ maximum: Int = 4096) throws -> Int {
    guard let value = value else { return fallback }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded() == number.doubleValue,
          number.intValue >= 1, number.intValue <= maximum else { throw MediaFailure.invalid }
    return number.intValue
}
func fileURL(_ value: Any?, output: Bool = false) throws -> URL {
    guard let path = value as? String, path.hasPrefix("/"), !path.contains("\0"), path.count <= 8192 else { throw MediaFailure.invalid }
    let url = URL(fileURLWithPath: path)
    if output {
        guard !FileManager.default.fileExists(atPath: path) else { throw MediaFailure.output }
        let parent = url.deletingLastPathComponent()
        let attr = try FileManager.default.attributesOfItem(atPath: parent.path)
        guard attr[.type] as? FileAttributeType == .typeDirectory,
              (attr[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { throw MediaFailure.output }
        let names = try FileManager.default.contentsOfDirectory(atPath: parent.path)
        if !names.isEmpty {
            guard names == ["owner.json"], parent.lastPathComponent.hasPrefix(".native-media-") else { throw MediaFailure.output }
            let token = String(parent.lastPathComponent.dropFirst(14)), markerURL = parent.appendingPathComponent("owner.json")
            let markerAttr = try FileManager.default.attributesOfItem(atPath: markerURL.path)
            guard UUID(uuidString: token) != nil, markerAttr[.type] as? FileAttributeType == .typeRegular,
                  (markerAttr[.size] as? NSNumber)?.intValue ?? 513 <= 512,
                  let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: markerURL)) as? [String: Any],
                  marker["version"] as? Int == 1, marker["owner"] as? String == "frameline-native-media", marker["token"] as? String == token else { throw MediaFailure.output }
        }
    } else {
        let attr = try FileManager.default.attributesOfItem(atPath: path)
        guard attr[.type] as? FileAttributeType == .typeRegular,
              imageExtensions.union(videoExtensions).contains(url.pathExtension.lowercased()) else { throw MediaFailure.unsupported }
    }
    return url
}
func seconds(_ request: [String: Any]) throws -> Double {
    var value = request["seconds"] as? Double ?? 0
    if let frame = request["frame"] as? NSNumber {
        guard CFGetTypeID(frame) != CFBooleanGetTypeID(), frame.doubleValue >= 0, frame.doubleValue.rounded() == frame.doubleValue else { throw MediaFailure.invalid }
        if let rate = request["frameRate"] as? [String: Any], let numerator = rate["numerator"] as? Double, let denominator = rate["denominator"] as? Double {
            guard numerator > 0, denominator > 0, numerator <= 1000000, denominator <= 1000000 else { throw MediaFailure.invalid }
            value = frame.doubleValue * denominator / numerator
        } else if let rate = request["frameRate"] as? Double, rate.isFinite, rate > 0, rate <= 1000 {
            value = frame.doubleValue / rate
        } else { throw MediaFailure.invalid }
    }
    guard value.isFinite && value >= 0 && value <= 86400 else { throw MediaFailure.invalid }
    return value
}
func assetInfo(_ url: URL) throws -> (AVURLAsset, Double, CGSize, Double) {
    // Never follow QuickTime external media references, including references to other local files.
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true,
        AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
    let duration = CMTimeGetSeconds(asset.duration)
    guard duration.isFinite && duration > 0, let track = asset.tracks(withMediaType: .video).first else { throw MediaFailure.unsupported }
    let rectangle = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
    return (asset, duration, CGSize(width: abs(rectangle.width), height: abs(rectangle.height)), Double(track.nominalFrameRate))
}
func image(_ url: URL, seconds: Double, maximum: CGSize) throws -> CGImage {
    if imageExtensions.contains(url.pathExtension.lowercased()) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let value = CGImageSourceCreateThumbnailAtIndex(source, 0,
            [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
             kCGImageSourceThumbnailMaxPixelSize: max(maximum.width, maximum.height)] as CFDictionary) else { throw MediaFailure.unsupported }
        return value
    }
    let (asset, duration, _, _) = try assetInfo(url)
    guard seconds < duration else { throw MediaFailure.invalid }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true; generator.maximumSize = maximum
    generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
    return try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 1000000000), actualTime: nil)
}
func canvas(_ width: Int, _ height: Int) throws -> CGContext {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw MediaFailure.output }
    context.setFillColor(CGColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context
}
func draw(_ picture: CGImage, in rectangle: CGRect, on context: CGContext) {
    let scale = min(rectangle.width / CGFloat(picture.width), rectangle.height / CGFloat(picture.height))
    let width = CGFloat(picture.width) * scale, height = CGFloat(picture.height) * scale
    context.draw(picture, in: CGRect(x: rectangle.midX - width / 2, y: rectangle.midY - height / 2, width: width, height: height))
}
func writePNG(_ picture: CGImage, _ output: URL) throws {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw MediaFailure.output }
    CGImageDestinationAddImage(destination, picture, nil)
    guard CGImageDestinationFinalize(destination), data.length <= 4 * 1024 * 1024 else { throw MediaFailure.tooLarge }
    let descriptor = open(output.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw MediaFailure.output }
    defer { close(descriptor) }
    let bytes = data as Data
    try bytes.withUnsafeBytes { pointer in
        var offset = 0
        while offset < bytes.count {
            let written = Darwin.write(descriptor, pointer.baseAddress!.advanced(by: offset), bytes.count - offset)
            guard written > 0 else { throw MediaFailure.output }; offset += written
        }
    }
    guard fsync(descriptor) == 0 else { throw MediaFailure.output }
}
func handle(_ request: [String: Any]) throws -> [String: Any] {
    guard let operation = request["operation"] as? String else { throw MediaFailure.invalid }
    if operation == "ping" { return ["provider": "apple-native", "version": 1, "canonical": false] }
    let width = try integer(request["width"], operation == "storyboard" ? 1280 : 640)
    let height = try integer(request["height"], operation == "storyboard" ? 720 : 360)
    if operation == "inspect" {
        let source = try fileURL(request["sourcePath"])
        if imageExtensions.contains(source.pathExtension.lowercased()) {
            guard let data = CGImageSourceCreateWithURL(source as CFURL, nil), let properties = CGImageSourceCopyPropertiesAtIndex(data, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw MediaFailure.unsupported }
            return ["kind": "image", "width": width, "height": height, "durationSeconds": NSNull(), "frameRate": NSNull(), "canonical": false]
        }
        let (_, duration, size, rate) = try assetInfo(source)
        return ["kind": "video", "width": Int(size.width), "height": Int(size.height), "durationSeconds": duration, "frameRate": rate > 0 ? rate : NSNull(), "canonical": false]
    }
    let output = try fileURL(request["outputPath"], output: true)
    if operation == "proxy" {
        let source = try fileURL(request["sourcePath"])
        if imageExtensions.contains(source.pathExtension.lowercased()) {
            let picture = try image(source, seconds: 0, maximum: CGSize(width: width, height: height))
            let context = try canvas(width, height); draw(picture, in: CGRect(x: 0, y: 0, width: width, height: height), on: context)
            guard let result = context.makeImage() else { throw MediaFailure.output }; try writePNG(result, output)
            return ["kind": "image-proxy", "mimeType": "image/png", "width": width, "height": height, "canonical": false]
        }
        let (asset, duration, _, _) = try assetInfo(source)
        guard duration <= 300 else { throw MediaFailure.tooLarge }
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset640x480), exporter.supportedFileTypes.contains(.mp4) else { throw MediaFailure.unsupported }
        exporter.outputURL = output; exporter.outputFileType = .mp4; exporter.metadata = []; exporter.shouldOptimizeForNetworkUse = false
        let semaphore = DispatchSemaphore(value: 0)
        exporter.exportAsynchronously { semaphore.signal() }
        guard semaphore.wait(timeout: .now() + 120) == .success else { exporter.cancelExport(); throw MediaFailure.unavailable }
        guard exporter.status == .completed else { throw MediaFailure.unsupported }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        let (_, exportedDuration, size, _) = try assetInfo(output)
        guard abs(exportedDuration - duration) <= 0.2 else { throw MediaFailure.output }
        return ["kind": "video-proxy", "mimeType": "video/mp4", "width": Int(size.width), "height": Int(size.height), "durationSeconds": exportedDuration, "canonical": false]
    }
    let context = try canvas(width, height)
    if operation == "thumbnail" {
        let source = try fileURL(request["sourcePath"])
        draw(try image(source, seconds: seconds(request), maximum: CGSize(width: width, height: height)), in: CGRect(x: 0, y: 0, width: width, height: height), on: context)
    } else if operation == "storyboard" {
        guard let clips = request["clips"] as? [[String: Any]], !clips.isEmpty, clips.count <= 24 else { throw MediaFailure.invalid }
        let columns = min(4, clips.count), rows = Int(ceil(Double(clips.count) / Double(columns)))
        let cellWidth = CGFloat(width) / CGFloat(columns), cellHeight = CGFloat(height) / CGFloat(rows)
        for (index, clip) in clips.enumerated() {
            let source = try fileURL(clip["sourcePath"]), x = CGFloat(index % columns) * cellWidth, y = CGFloat(height) - CGFloat(index / columns + 1) * cellHeight
            let labelHeight = min(24, cellHeight * 0.2)
            let picture = try image(source, seconds: seconds(clip), maximum: CGSize(width: cellWidth, height: cellHeight - labelHeight))
            draw(picture, in: CGRect(x: x + 3, y: y + labelHeight, width: cellWidth - 6, height: cellHeight - labelHeight - 3), on: context)
            let label = String((clip["label"] as? String ?? "Clip \(index + 1)").prefix(100))
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
            (label as NSString).draw(in: CGRect(x: x + 6, y: y + 2, width: cellWidth - 12, height: labelHeight), withAttributes: [.font: NSFont.systemFont(ofSize: max(9, min(13, labelHeight - 4))), .foregroundColor: NSColor.white, .paragraphStyle: style])
            NSGraphicsContext.restoreGraphicsState()
        }
    } else { throw MediaFailure.invalid }
    guard let result = context.makeImage() else { throw MediaFailure.output }; try writePNG(result, output)
    return ["kind": operation, "mimeType": "image/png", "width": width, "height": height, "canonical": false]
}
do {
    var data = Data()
    while true {
        let chunk = FileHandle.standardInput.readData(ofLength: min(8192, 256 * 1024 + 1 - data.count))
        if chunk.isEmpty { break }
        data.append(chunk)
        guard data.count <= 256 * 1024 else { throw MediaFailure.invalid }
    }
    guard data.count > 0, data.count <= 256 * 1024, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MediaFailure.invalid }
    let response = try handle(request)
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: response)); FileHandle.standardOutput.write(Data([10]))
} catch {
    let code: String
    switch error { case MediaFailure.invalid: code = "native-media-input-invalid"
      case MediaFailure.tooLarge: code = "native-media-limit-exceeded"
      case MediaFailure.output: code = "native-media-output-invalid"
      default: code = "native-media-unavailable" }
    FileHandle.standardOutput.write(Data("{\"error\":\"\(code)\"}\n".utf8)); exit(1)
}
