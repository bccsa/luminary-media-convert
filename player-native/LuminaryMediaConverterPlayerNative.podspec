require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The iOS side of the plugin, for CocoaPods hosts. Capacitor names the pod after the npm package
# (@luminary-media-converter/player-native), so the name is not ours to choose. The same sources as the Swift package's
# LuminaryPlayerCore and LuminaryPlayerUI targets, plus the Capacitor shim, in one module.
Pod::Spec.new do |s|
  s.name = 'LuminaryMediaConverterPlayerNative'
  s.version = package['version']
  s.summary = 'The Luminary native player: AVPlayer behind the bridge contract.'
  s.license = package['license']
  s.homepage = 'https://github.com/bccsa/luminary-media-convert'
  s.author = 'BCC South Africa'
  s.source = { :git => 'https://github.com/bccsa/luminary-media-convert.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
