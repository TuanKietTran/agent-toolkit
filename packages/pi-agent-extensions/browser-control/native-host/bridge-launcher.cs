// .NET Framework 4.x / C# 5 Native Messaging launcher. Chrome starts this executable
// without arguments; it relays the stdio byte stream unchanged to the configured Node host.
using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class HostConfig {
    public string nodeExecutable { get; set; }
    public string hostScript { get; set; }
    public string socketPath { get; set; }
}
public static class BridgeLauncher {
    static string ConfigPath() {
        return Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "host-config.json");
    }
    static HostConfig ReadConfig() {
        string path = ConfigPath();
        DirectorySecurity directorySecurity = Directory.GetAccessControl(Path.GetDirectoryName(path));
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        if (!directorySecurity.GetOwner(typeof(SecurityIdentifier)).Equals(current)) throw new UnauthorizedAccessException("Native host config directory is not owned by the current user");
        AuthorizationRuleCollection directoryRules = directorySecurity.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in directoryRules) {
            SecurityIdentifier sid = rule.IdentityReference as SecurityIdentifier;
            if (sid == null || !sid.Equals(current)) throw new UnauthorizedAccessException("Native host config directory is accessible to another principal");
        }
        FileSecurity security = File.GetAccessControl(path);
        if (!security.GetOwner(typeof(SecurityIdentifier)).Equals(current)) throw new UnauthorizedAccessException("Native host config is not owned by the current user");
        AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules) {
            SecurityIdentifier sid = rule.IdentityReference as SecurityIdentifier;
            if (sid == null || !sid.Equals(current))
                throw new UnauthorizedAccessException("Native host config has a non-user access rule");
        }
        string json = File.ReadAllText(path, new UTF8Encoding(false, true));
        HostConfig config = new JavaScriptSerializer { MaxJsonLength = 16384 }.Deserialize<HostConfig>(json);
        string normalizedScript = config == null ? "" : Path.GetFullPath(config.hostScript);
        if (config == null || !Path.IsPathRooted(config.nodeExecutable) || !Path.IsPathRooted(config.hostScript) || !File.Exists(config.nodeExecutable) || !File.Exists(config.hostScript)
            || !String.Equals(Path.GetFileName(config.nodeExecutable), "node.exe", StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Path.GetFileName(normalizedScript), "bridge-host.mjs", StringComparison.OrdinalIgnoreCase)
            || !normalizedScript.Contains(Path.DirectorySeparatorChar + "browser-control" + Path.DirectorySeparatorChar + "native-host" + Path.DirectorySeparatorChar)
            || config.socketPath == null || !ValidPipe(config.socketPath))
            throw new InvalidDataException("Native host config must name allowlisted absolute Node/script paths and a per-user bridge pipe");
        return config;
    }
    static bool ValidPipe(string value) {
        const string prefix = @"\\.\pipe\pi-browser-bridge-";
        return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && System.Text.RegularExpressions.Regex.IsMatch(value.Substring(prefix.Length), "^[a-f0-9]{32}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    public static int Main() {
        try {
            HostConfig config = ReadConfig();
            ProcessStartInfo info = new ProcessStartInfo(config.nodeExecutable, Quote(config.hostScript) + " --native");
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.EnvironmentVariables["PI_BROWSER_BRIDGE_SOCKET"] = config.socketPath;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            using (Process child = Process.Start(info)) {
                // Copy raw bytes, not text: Chrome Native Messaging framing must remain byte-exact.
                Stream stdin = Console.OpenStandardInput(), stdout = Console.OpenStandardOutput();
                Task inputCopy = Task.Factory.StartNew(() => { stdin.CopyTo(child.StandardInput.BaseStream); child.StandardInput.BaseStream.Close(); });
                Task outputCopy = Task.Factory.StartNew(() => child.StandardOutput.BaseStream.CopyTo(stdout));
                Task errorDrain = Task.Factory.StartNew(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
                Task.WaitAll(inputCopy, outputCopy, errorDrain);
                child.WaitForExit();
                return child.ExitCode;
            }
        } catch (Exception error) {
            Console.Error.WriteLine("browser bridge launcher: " + error.Message);
            return 1;
        }
    }
}
