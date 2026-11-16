import AppKit
import Foundation

guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let representation = image.representations.first else {
    fatalError("The DMG background could not be decoded by AppKit.")
}
// Finder consumes NSImage points, not raw pixel dimensions. A 144 dpi PNG
// supplies 2x pixels while preserving the 720x480 point installer layout.
guard abs(image.size.width - 720) < 0.5,
      abs(image.size.height - 480) < 0.5,
      representation.pixelsWide == 1440,
      representation.pixelsHigh == 960 else {
    fatalError("The DMG background must be 720x480 logical points with 2x pixels.")
}
print("DMG background: 720x480 points, 1440x960 pixels, AppKit verified")
