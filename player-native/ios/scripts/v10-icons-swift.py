#!/usr/bin/env python3
"""Writes ios/Sources/LuminaryPlayerCore/V10Icons.swift from Android's V10Icons.kt, which
android/scripts/extract-v10-icons.mjs writes from the icons Video.js 10's default skin ships.
Run from the repository root: python3 player-native/ios/scripts/v10-icons-swift.py"""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
src = (root / 'android/src/main/java/org/bccsa/luminary/player/engine/V10Icons.kt').read_text()
out = [
    "// Generated from player-native/android/src/main/java/org/bccsa/luminary/player/engine/V10Icons.kt, which",
    "// player-native/android/scripts/extract-v10-icons.mjs writes from the icons Video.js 10's default skin ships.",
    "// Do not edit: regenerate it by running player-native/ios/scripts/v10-icons-swift.py.",
    "",
    "/// SVG path data on an 18-unit grid, y downwards, in layers: some are half-opaque, and a few are outlines.",
    "public enum V10Icons {",
    "    public static let grid: Double = 18",
    "",
    "    public struct Layer: Sendable {",
    "        public let path: String",
    "        public let alpha: Double",
    "        public let strokeWidth: Double",
    "    }",
    "",
]
for m in re.finditer(r'val (\w+) = listOf\((.*?)\n    \)', src, re.S):
    name, body = m.groups()
    out.append(f'    public static let {name}: [Layer] = [')
    for l in re.finditer(r'Layer\("([^"]*)", ([\d.]+)f, ([\d.]+)f\)', body):
        out.append(f'        Layer(path: "{l.group(1)}", alpha: {l.group(2)}, strokeWidth: {l.group(3)}),')
    out.append('    ]')
out.append('}')
(root / 'ios/Sources/LuminaryPlayerCore/V10Icons.swift').write_text('\n'.join(out) + '\n')
