import Foundation
import Vision
import ImageIO

// Read the original ADB PNG; no crop, recolour, or reconstructed screen.
guard CommandLine.arguments.count == 2 else { exit(2) }
do {
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let top = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return ["text": top.string, "confidence": top.confidence,
                "box": ["x": box.minX, "y": box.minY, "width": box.width, "height": box.height]]
    }
    let result: [String: Any] = ["status": "available", "engine": "Apple Vision",
        "text": lines.compactMap { $0["text"] as? String }.joined(separator: "\n"), "lines": lines]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8))
    exit(1)
}
