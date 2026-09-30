import AVKit
import SwiftUI

@main
struct SpikeApp: App {
    @StateObject private var model = PlayerModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task {
                    // `-autorun` (from `devicectl … --console`) runs step 0
                    // unattended and prints its findings to stdout.
                    if CommandLine.arguments.contains("-autorun") {
                        await model.autorun(secondsPerVisit: 8)
                    }
                }
        }
    }
}

struct ContentView: View {
    @ObservedObject var model: PlayerModel

    var body: some View {
        VStack(spacing: 8) {
            PlayerView(controller: model.controller)
                .aspectRatio(16 / 9, contentMode: .fit)

            Picker("Content type", selection: $model.mode) {
                ForEach(AssetLoader.TypeMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            if let payload = model.payload {
                HStack {
                    ForEach(Array(payload.visits.enumerated()), id: \.offset) { index, visit in
                        Button(payload.name(of: visit)) {
                            if index == 0 { model.reset() }
                            model.play(visit, at: index == 0 ? .zero : model.player.currentTime())
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.autorunning)
                    }
                }
            }

            ScrollView {
                Text(model.lines.joined(separator: "\n"))
                    .font(.system(size: 10, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(8)
    }
}

struct PlayerView: UIViewControllerRepresentable {
    let controller: AVPlayerViewController

    func makeUIViewController(context: Context) -> AVPlayerViewController { controller }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}
