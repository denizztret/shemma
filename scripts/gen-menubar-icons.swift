import Cocoa

// Генератор packages/shemma-cli/src/menubar/icons.ts — иконки menu bar.
// Использование (из корня репо):
//   swift scripts/gen-menubar-icons.swift > packages/shemma-cli/src/menubar/icons.ts
// Статусные — цветные PNG @2x (image= в title; sfimage там был бы template).
// Пункты меню — чёрный template-PNG @2x pt 16 (templateImage=, SwiftBar
// инвертирует под тему); sfimage= рендерится заметно мельче — паттерн и
// размеры 1-в-1 как в madstudio-helper (gen-icons.swift).
// Символ статуса square.on.square — «слои канваса» (см. спеку).

/// render <symbol> pt <pointSize> color <nil → чёрный template> → PNG @2x.
func render(_ name: String, pt: CGFloat, color: NSColor?) -> Data {
    let scale = 2
    let cfg = NSImage.SymbolConfiguration(pointSize: pt, weight: .regular)
    guard let sym = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(cfg) else { fatalError("no symbol \(name)") }
    let ptSize = sym.size
    let pxW = Int(ptSize.width * CGFloat(scale)), pxH = Int(ptSize.height * CGFloat(scale))
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pxW, pixelsHigh: pxH,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("no rep") }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let r = NSRect(origin: .zero, size: ptSize)
    sym.draw(in: r)
    (color ?? .black).set()
    r.fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func c(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

func emitTs(_ name: String, _ data: Data) {
    print("export const \(name) = \"\(data.base64EncodedString())\";")
}

print("// Сгенерировано scripts/gen-menubar-icons.swift — НЕ редактировать руками.")
print("// Статус (SF square.on.square @2x, цветные): работает / остановлен / ошибка.")
emitTs("ICON_RUNNING", render("square.on.square", pt: 16, color: c(0x34C759)))
emitTs("ICON_STOPPED", render("square.on.square", pt: 16, color: c(0x8E8E93)))
emitTs("ICON_ERROR", render("square.on.square", pt: 16, color: c(0xFF3B30)))
print("// Пункты меню (SF @2x pt 16, чёрный template — SwiftBar инвертирует под тему).")
let menu: [(String, String)] = [
    ("ICON_MENU_PLAY", "play"),
    ("ICON_MENU_STOP", "stop"),
    ("ICON_MENU_RESTART", "arrow.clockwise"),
    ("ICON_MENU_STOP_ALL", "xmark.octagon"),
    ("ICON_MENU_BOARD", "rectangle.on.rectangle"),
    ("ICON_MENU_SPACES", "square.grid.2x2"),
    ("ICON_MENU_LOG", "doc.plaintext"),
    ("ICON_MENU_CONFIG", "gearshape"),
    ("ICON_MENU_UPDATE", "arrow.down.circle"),
]
for (v, s) in menu {
    emitTs(v, render(s, pt: 16, color: nil))
}
