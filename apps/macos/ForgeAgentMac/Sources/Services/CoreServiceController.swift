import AppKit
import Foundation

enum CoreServiceStatus: Equatable {
    case starting
    case ready
    case degraded(String)
    case restarting
}

@MainActor
final class CoreServiceController: ObservableObject {
    @Published var status: CoreServiceStatus = .starting
    @Published var reloadNonce = UUID()
    @Published private(set) var currentPort = 3000

    let preferredPort = 3000
    private var lateHealthRecoveryTask: Task<Void, Never>?

    var consoleURL: URL {
        URL(string: "http://127.0.0.1:\(currentPort)/")!
    }

    var logURL: URL {
        supportDirectory.appendingPathComponent("forgeagent.log")
    }

    private var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ForgeAgent", isDirectory: true)
    }

    private var dataDirectory: URL {
        supportDirectory.appendingPathComponent("data", isDirectory: true)
    }

    private var launchScriptURL: URL {
        supportDirectory.appendingPathComponent("launchd-start.sh")
    }

    private var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.forgeagent.gateway.plist")
    }

    func bootstrap() async {
        status = .starting
        lateHealthRecoveryTask?.cancel()
        do {
            if try await adoptHealthyExistingService() {
                status = .ready
                reloadNonce = UUID()
                return
            }

            try installLaunchAgent()
            if try await waitForHealth(timeout: 90) {
                status = .ready
                reloadNonce = UUID()
            } else {
                status = .degraded("ForgeAgent Core is still starting. The app will reconnect automatically; use Open Logs if it does not recover.")
                startLateHealthRecovery()
            }
        } catch {
            status = .degraded(error.localizedDescription)
            startLateHealthRecovery()
        }
    }

    func restartCore() async {
        status = .restarting
        lateHealthRecoveryTask?.cancel()
        do {
            try bootoutLaunchAgent()
            try installLaunchAgent()
            if try await waitForHealth(timeout: 90) {
                status = .ready
                reloadNonce = UUID()
            } else {
                status = .degraded("ForgeAgent Core is still restarting. The app will reconnect automatically; use Open Logs if it does not recover.")
                startLateHealthRecovery()
            }
        } catch {
            status = .degraded(error.localizedDescription)
            startLateHealthRecovery()
        }
    }

    func openConsoleInBrowser() {
        NSWorkspace.shared.open(consoleURL)
    }

    func showLogs() {
        NSWorkspace.shared.open(logURL)
    }

    private func waitForHealth(timeout: TimeInterval) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await healthReady() { return true }
            try await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    private func healthReady() async throws -> Bool {
        if try await healthReady(port: currentPort) {
            return true
        }
        if let statePort = readRunStatePort(), statePort != currentPort {
            if try await healthReady(port: statePort) {
                currentPort = statePort
                return true
            }
        }
        return false
    }

    private func healthReady(port: Int) async throws -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        request.timeoutInterval = 1.5
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func adoptHealthyExistingService() async throws -> Bool {
        guard let statePort = readRunStatePort() else {
            return false
        }
        guard launchScriptUsesPowerHelper() else {
            return false
        }
        guard launchAgentIsRunning() else {
            return false
        }
        if try await healthReady(port: statePort) {
            currentPort = statePort
            return true
        }
        return false
    }

    private func startLateHealthRecovery() {
        lateHealthRecoveryTask?.cancel()
        lateHealthRecoveryTask = Task { @MainActor [weak self] in
            let deadline = Date().addingTimeInterval(180)
            while !Task.isCancelled && Date() < deadline {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                if (try? await self.healthReady()) == true {
                    self.status = .ready
                    self.reloadNonce = UUID()
                    return
                }
            }
        }
    }

    private func installLaunchAgent() throws {
        try FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bootoutLaunchAgent(allowFailure: true)
        terminateStaleBundledCoreProcesses()
        currentPort = chooseAvailablePort()
        try writeVoiceTranscribeScript()
        try writeLaunchScript()
        try renderPlist().write(to: plistURL, atomically: true, encoding: .utf8)
        _ = try run("/bin/launchctl", ["bootstrap", launchdDomain(), plistURL.path])
        _ = try run("/bin/launchctl", ["kickstart", "-k", "\(launchdDomain())/com.forgeagent.gateway"], allowFailure: true)
    }

    private func bootoutLaunchAgent(allowFailure: Bool = true) throws {
        _ = try run("/bin/launchctl", ["bootout", launchdDomain(), plistURL.path], allowFailure: allowFailure)
    }

    private func readRunStatePort() -> Int? {
        let stateURL = dataDirectory.appendingPathComponent("run/gateway.json")
        guard let data = try? Data(contentsOf: stateURL),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let app = parsed["app"] as? String,
              app == "ForgeAgent",
              let port = parsed["port"] as? Int else {
            return nil
        }
        return port
    }

    private func launchScriptUsesPowerHelper() -> Bool {
        guard let content = try? String(contentsOf: launchScriptURL, encoding: .utf8) else {
            return false
        }
        return content.contains("ForgeAgentPowerHelper")
    }

    private func launchAgentIsRunning() -> Bool {
        let output = (try? run("/bin/launchctl", ["print", "\(launchdDomain())/com.forgeagent.gateway"], allowFailure: true)) ?? ""
        return output.contains("state = running") && output.contains("pid =")
    }

    private func terminateStaleBundledCoreProcesses() {
        let marker = "ForgeAgent.app/Contents/Resources/ForgeAgentCore/src/gateways/http/main.ts"
        let output = (try? run("/usr/bin/pgrep", ["-f", marker], allowFailure: true)) ?? ""
        let pids = output
            .split(whereSeparator: \.isNewline)
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { $0 > 0 && $0 != getpid() }

        guard !pids.isEmpty else {
            return
        }

        for pid in pids {
            kill(pid, SIGTERM)
        }
        Thread.sleep(forTimeInterval: 1.0)
        for pid in pids where kill(pid, 0) == 0 {
            kill(pid, SIGKILL)
        }
    }

    private func writeLaunchScript() throws {
        guard let coreRoot = resolveCoreRoot() else {
            throw NSError(domain: "ForgeAgentMac", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Could not find bundled ForgeAgent Core resources."
            ])
        }
        let node = resolveNodePath()
        let powerHelper = resolvePowerHelperPath()
        let tsx = coreRoot.appendingPathComponent("node_modules/tsx/dist/cli.mjs").path
        let main = coreRoot.appendingPathComponent("src/gateways/http/main.ts").path
        let voicePython = supportDirectory
            .appendingPathComponent("voice-venv/bin/python")
            .path
        let voiceModel = supportDirectory
            .appendingPathComponent("models/belle-whisper-large-v3-turbo-zh-ggml-q5_0/ggml-belle-large-v3-turbo-zh-q5_0.bin")
            .path
        let voiceTranscribe = supportDirectory
            .appendingPathComponent("voice-transcribe.sh")
            .path
        let launchCommand: String
        if let powerHelper {
            launchCommand = """
            exec '\(shellQuote(powerHelper))' --working-directory '\(shellQuote(coreRoot.path))' -- '\(shellQuote(node))' '\(shellQuote(tsx))' '\(shellQuote(main))'
            """
        } else {
            launchCommand = """
            exec '\(shellQuote(node))' '\(shellQuote(tsx))' '\(shellQuote(main))'
            """
        }
        let script = """
        #!/bin/zsh
        set -e
        export FORGE_DATA_DIR='\(shellQuote(dataDirectory.path))'
        export HTTP_HOST='0.0.0.0'
        export HTTP_PORT='\(currentPort)'
        export HOME='\(shellQuote(FileManager.default.homeDirectoryForCurrentUser.path))'
        export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
        export FORGE_VOICE_PYTHON='\(shellQuote(voicePython))'
        export FORGE_WHISPER_MODEL='\(shellQuote(voiceModel))'
        export FORGE_VOICE_TRANSCRIBE_COMMAND='\(shellQuote(voiceTranscribe))'
        export FORGE_VOICE_TRANSCRIBE_ARGS='{audio} {model} {language} {mode}'
        cd '\(shellQuote(coreRoot.path))'
        \(launchCommand)
        """
        try script.write(to: launchScriptURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchScriptURL.path)
    }

    private func writeVoiceTranscribeScript() throws {
        let scriptURL = supportDirectory.appendingPathComponent("voice-transcribe.sh")
        let script = """
        #!/bin/zsh
        set -euo pipefail
        AUDIO="$1"
        MODEL="$2"
        LANG="${3:-zh}"
        MODE="${4:-final}"
        WORKDIR="$(dirname "$AUDIO")"
        EXT="${AUDIO:e:l}"
        INPUT="$AUDIO"
        TMP=""
        if [[ "$EXT" != "wav" && "$EXT" != "mp3" && "$EXT" != "ogg" && "$EXT" != "flac" ]]; then
          TMP="$WORKDIR/voice-transcribe-$$.wav"
          /opt/homebrew/bin/ffmpeg -y -loglevel error -i "$AUDIO" -ar 16000 -ac 1 "$TMP"
          INPUT="$TMP"
        fi
        cleanup() {
          if [[ -n "$TMP" && -f "$TMP" ]]; then rm -f "$TMP"; fi
        }
        trap cleanup EXIT
        FAST_ARGS=()
        if [[ "$MODE" == "preview" ]]; then
          FAST_ARGS=(-bs 1 -bo 1 -nf)
        fi
        cd "$WORKDIR"
        /opt/homebrew/bin/whisper-cli -m "$MODEL" -f "$INPUT" -l "$LANG" -nt -np "${FAST_ARGS[@]}"
        """
        try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
    }

    private func renderPlist() -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.forgeagent.gateway</string>
          <key>ProgramArguments</key>
          <array>
            <string>/bin/zsh</string>
            <string>\(xmlEscape(launchScriptURL.path))</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>StandardOutPath</key>
          <string>\(xmlEscape(logURL.path))</string>
          <key>StandardErrorPath</key>
          <string>\(xmlEscape(logURL.path))</string>
        </dict>
        </plist>
        """
    }

    private func resolveCoreRoot() -> URL? {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("ForgeAgentCore"),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("src/gateways/http/main.ts").path) {
            return bundled
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        if FileManager.default.fileExists(atPath: cwd.appendingPathComponent("src/gateways/http/main.ts").path) {
            return cwd
        }
        return nil
    }

    private func resolvePowerHelperPath() -> String? {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("ForgeAgentPowerHelper"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled.path
        }
        return nil
    }

    private func resolveNodePath() -> String {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node/bin/node"),
           executableWorks(bundled.path) {
            return bundled.path
        }
        if let env = ProcessInfo.processInfo.environment["FORGE_NODE_BIN"], !env.isEmpty {
            return env
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if executableWorks(candidate) {
                return candidate
            }
        }
        return "/opt/homebrew/bin/node"
    }

    private func executableWorks(_ path: String) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: path) else {
            return false
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--version"]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func chooseAvailablePort() -> Int {
        let candidates = [preferredPort, 3130, 3140, 3150] + Array(3001...3099)
        return candidates.first(where: isPortAvailable) ?? preferredPort
    }

    private func isPortAvailable(_ port: Int) -> Bool {
        let output = (try? run("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN"], allowFailure: true)) ?? ""
        return output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func run(_ executable: String, _ args: [String], allowFailure: Bool = false) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 && !allowFailure {
            throw NSError(domain: "ForgeAgentMac", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: output.isEmpty ? "\(executable) failed." : output
            ])
        }
        return output
    }

    private func launchdDomain() -> String {
        "gui/\(getuid())"
    }

    private func shellQuote(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "'\\''")
    }

    private func xmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}
