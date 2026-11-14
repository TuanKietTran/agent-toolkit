// Prints "<width>x<height>" then one recognised text line per row: "[top|mid|bottom left|center|right] text".
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count > 1,
      let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  FileHandle.standardError.write(Data("cannot read image\n".utf8))
  exit(2)
}
print("\(image.width)x\(image.height)")
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
let rows = (request.results ?? []).compactMap { obs -> (CGRect, String)? in
  guard let top = obs.topCandidates(1).first else { return nil }
  return (obs.boundingBox, top.string)
}.sorted { a, b in abs(a.0.midY - b.0.midY) > 0.02 ? a.0.midY > b.0.midY : a.0.midX < b.0.midX }
for (box, text) in rows {
  let v = box.midY > 0.66 ? "top" : box.midY > 0.33 ? "mid" : "bottom"
  let h = box.midX < 0.33 ? "left" : box.midX < 0.66 ? "center" : "right"
  print("[\(v) \(h)] \(text)")
}
