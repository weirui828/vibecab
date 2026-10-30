import AppKit
import CoreGraphics
import ImageIO
import Foundation

func sourceImage(_ path: String) throws -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain: "VibeCabIcons", code: 1) }
  return image
}

func writePNG(_ image: CGImage, _ path: String) throws {
  guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else {
    throw NSError(domain: "VibeCabIcons", code: 2)
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "VibeCabIcons", code: 3) }
}

func render(_ image: CGImage, size: Int, template: Bool = false) throws -> CGImage {
  let buffer = UnsafeMutableRawPointer.allocate(byteCount: size * size * 4, alignment: 16)
  defer { buffer.deallocate() }
  memset(buffer, 0, size * size * 4)
  guard let context = CGContext(data: buffer, width: size, height: size, bitsPerComponent: 8,
                                bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw NSError(domain: "VibeCabIcons", code: 4)
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
  if template {
    let pixels = buffer.assumingMemoryBound(to: UInt8.self)
    for pixel in 0..<(size * size) {
      let i = pixel * 4
      let luminance = (0.2126 * Double(pixels[i]) + 0.7152 * Double(pixels[i + 1]) + 0.0722 * Double(pixels[i + 2])) / 255.0
      let alpha = max(0.0, min(1.0, (0.91 - luminance) / 0.70))
      pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = UInt8((alpha * 255).rounded())
    }
  }
  guard let output = context.makeImage() else { throw NSError(domain: "VibeCabIcons", code: 5) }
  return output
}

let args = CommandLine.arguments
let source = try sourceImage(args[1])
let output = args[2]
let icon1024 = try render(source, size: 1024)
try writePNG(icon1024, args[3])
for size in [16, 32, 128, 256, 512] {
  try writePNG(render(source, size: size), "\(output)/icon_\(size)x\(size).png")
  if size < 512 { try writePNG(render(source, size: size * 2), "\(output)/icon_\(size)x\(size)@2x.png") }
}
try writePNG(render(source, size: 1024), "\(output)/icon_512x512@2x.png")
try writePNG(render(source, size: 16, template: true), args[4])
try writePNG(render(source, size: 32, template: true), args[5])
