// .NET Framework 4.x / C# 5. Manifest mode validates origin and relays raw
// Native Messaging stdio to Node --native. --broker is the secure pipe front end.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class HostConfig {
    public string nodeExecutable { get; set; }
    public string hostScript { get; set; }
    public string pipeName { get; set; }
    public string extensionOrigin { get; set; }
}
public static class BridgeLauncher {
    const int MaxMuxFrame = 1024 * 1024;
    const int MaxPipeInstances = 32;
    const int ChunkBytes = 48 * 1024;
    const uint PipeAccessDuplex = 0x00000003, FileFlagOverlapped = 0x40000000, FileFlagFirstPipeInstance = 0x00080000;
    const uint PipeTypeByte = 0, PipeReadModeByte = 0, PipeWait = 0, PipeRejectRemoteClients = 0x00000008;
    const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, OpenExisting = 3;
    const uint TokenQuery = 0x0008;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxMuxFrame };
    static readonly object NodeWriteLock = new object();
    static readonly ConcurrentDictionary<string, Peer> Peers = new ConcurrentDictionary<string, Peer>();
    static readonly object PeerSetLock = new object();
    static Process broker;
    static string configPath;

    sealed class Peer {
        public NamedPipeServerStream Stream;
        public object WriteLock = new object();
        public object CloseLock = new object();
        public volatile bool Closed;
        public bool LocalCloseSent;
        public bool RemoteCloseReceived;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr SecurityDescriptor; public bool InheritHandle; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ConnectNamedPipe(SafePipeHandle pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientPid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientComputerName(SafePipeHandle pipe, StringBuilder name, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(SafeFileHandle token, int infoClass, IntPtr buffer, int length, out int returned);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafePipeHandle pipe, byte[] buffer, int count, out int read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafePipeHandle pipe, byte[] buffer, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(SafePipeHandle pipe);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetNamedPipeHandleState(SafePipeHandle pipe, ref uint mode, IntPtr maxCollection, IntPtr collectTimeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeHandleState(SafePipeHandle pipe, IntPtr state, IntPtr curInstances, IntPtr maxCollection, IntPtr collectTimeout, StringBuilder username, int maxUserName);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeInfo(SafePipeHandle pipe, out uint flags, out uint outSize, out uint inSize, out uint maxInstances);

    static string ConfigPathFromExe() { return Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "host-config.json"); }
    static HostConfig LoadConfig(string path) {
        if (!Path.IsPathRooted(path) || !File.Exists(path)) throw new InvalidDataException("Expected an absolute host config path");
        string dir = Path.GetDirectoryName(path);
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        CheckOwnerOnly(Directory.GetAccessControl(dir), current, "config directory");
        CheckOwnerOnly(File.GetAccessControl(path), current, "config file");
        HostConfig c = Json.Deserialize<HostConfig>(File.ReadAllText(path, new UTF8Encoding(false, true)));
        if (c == null || !Path.IsPathRooted(c.nodeExecutable) || !Path.IsPathRooted(c.hostScript) || !File.Exists(c.nodeExecutable) || !File.Exists(c.hostScript)
            || !String.Equals(Path.GetFileName(c.nodeExecutable), "node.exe", StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Path.GetFileName(c.hostScript), "bridge-host.mjs", StringComparison.OrdinalIgnoreCase)
            || !c.hostScript.Contains(Path.DirectorySeparatorChar + "browser-control" + Path.DirectorySeparatorChar + "native-host" + Path.DirectorySeparatorChar)
            || !String.Equals(c.extensionOrigin, "chrome-extension://" + ExtensionId(c.extensionOrigin) + "/", StringComparison.Ordinal)
            || !ValidPipe(c.pipeName)) throw new InvalidDataException("Invalid host config paths, extension origin, or pipe name");
        return c;
    }
    static string ExtensionId(string origin) {
        const string prefix = "chrome-extension://";
        if (String.IsNullOrEmpty(origin) || !origin.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("Invalid configured extension origin");
        string id = origin.Substring(prefix.Length).TrimEnd('/');
        if (id.Length != 32) throw new InvalidDataException("Invalid configured extension ID");
        foreach (char ch in id) if (ch < 'a' || ch > 'p') throw new InvalidDataException("Invalid configured extension ID");
        return id;
    }
    static bool ValidPipe(string pipe) {
        const string prefix = @"\\.\pipe\pi-browser-bridge-";
        if (String.IsNullOrEmpty(pipe) || !pipe.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        string suffix = pipe.Substring(prefix.Length);
        if (suffix.Length != 32) return false;
        foreach (char ch in suffix) if (!Uri.IsHexDigit(ch)) return false;
        return true;
    }
    static void CheckOwnerOnly(FileSystemSecurity acl, SecurityIdentifier current, string label) {
        if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(current)) throw new UnauthorizedAccessException("Host " + label + " owner mismatch");
        foreach (AuthorizationRule raw in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            FileSystemAccessRule rule = raw as FileSystemAccessRule;
            SecurityIdentifier sid = rule == null ? null : rule.IdentityReference as SecurityIdentifier;
            if (sid == null || (!sid.Equals(current) && !sid.IsWellKnown(WellKnownSidType.LocalSystemSid) && !sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)))
                throw new UnauthorizedAccessException("Host " + label + " grants an untrusted principal");
        }
    }
    static PipeSecurity PipeAcl() {
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(user);
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }
    static NamedPipeServerStream NewServer(string name, bool first) {
        byte[] descriptor = PipeAcl().GetSecurityDescriptorBinaryForm();
        IntPtr sd = Marshal.AllocHGlobal(descriptor.Length);
        try {
            Marshal.Copy(descriptor, 0, sd, descriptor.Length);
            SecurityAttributes attrs = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), SecurityDescriptor = sd, InheritHandle = false };
            uint mode = PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients;
            uint flags = PipeAccessDuplex | FileFlagOverlapped | (first ? FileFlagFirstPipeInstance : 0);
            SafePipeHandle handle = CreateNamedPipe(name, flags, mode, MaxPipeInstances, ChunkBytes, ChunkBytes, 0, ref attrs);
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Secure first-instance named pipe creation failed");
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        } finally { Marshal.FreeHGlobal(sd); }
    }
    static bool IsTrustedPeer(SafePipeHandle pipe, bool serverSide) {
        uint pid; bool ok = serverSide ? GetNamedPipeClientProcessId(pipe, out pid) : GetNamedPipeServerProcessId(pipe, out pid);
        if (!ok) return false;
        IntPtr process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return false;
        try {
            SafeFileHandle token; if (!OpenProcessToken(process, TokenQuery, out token)) return false;
            using (token) {
                int size; GetTokenInformation(token, 1, IntPtr.Zero, 0, out size);
                IntPtr data = Marshal.AllocHGlobal(size);
                try {
                    if (!GetTokenInformation(token, 1, data, size, out size)) return false;
                    IntPtr sidPtr = Marshal.ReadIntPtr(data);
                    SecurityIdentifier sid = new SecurityIdentifier(sidPtr);
                    SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
                    return sid.Equals(current) || sid.IsWellKnown(WellKnownSidType.LocalSystemSid) || sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
                } finally { Marshal.FreeHGlobal(data); }
            }
        } finally { CloseHandle(process); }
    }
    static bool IsRemote(SafePipeHandle pipe) {
        StringBuilder computer = new StringBuilder(256);
        // PIPE_REJECT_REMOTE_CLIENTS is enforced in CreateNamedPipe; this extra check
        // rejects a reported remote computer but does not fail local peers if the API is unavailable.
        if (!GetNamedPipeClientComputerName(pipe, computer, (uint)computer.Capacity)) return false;
        return !String.Equals(computer.ToString(), Environment.MachineName, StringComparison.OrdinalIgnoreCase);
    }
    static byte[] ReadExact(Stream stream, int length) {
        byte[] data = new byte[length]; int at = 0;
        while (at < length) { int n = stream.Read(data, at, length - at); if (n == 0) return null; at += n; }
        return data;
    }
    static async Task<byte[]> ReadExactAsync(Stream stream, int length, CancellationToken cancel) {
        byte[] data = new byte[length]; int at = 0;
        while (at < length) { int n = await stream.ReadAsync(data, at, length - at, cancel).ConfigureAwait(false); if (n == 0) return null; at += n; }
        return data;
    }
    static void WriteMux(Process child, object value) {
        byte[] json = Encoding.UTF8.GetBytes(Json.Serialize(value));
        if (json.Length == 0 || json.Length > MaxMuxFrame) throw new InvalidDataException("Node relay frame exceeds 1 MiB");
        byte[] header = BitConverter.GetBytes((uint)json.Length);
        lock (NodeWriteLock) { child.StandardInput.BaseStream.Write(header, 0, 4); child.StandardInput.BaseStream.Write(json, 0, json.Length); child.StandardInput.BaseStream.Flush(); }
    }
    static async Task ReadNodeFrames(Process child, CancellationToken cancellation) {
        Stream stream = child.StandardOutput.BaseStream;
        while (!cancellation.IsCancellationRequested) {
            byte[] h = await ReadExactAsync(stream, 4, cancellation).ConfigureAwait(false); if (h == null) break;
            uint n = BitConverter.ToUInt32(h, 0); if (n == 0 || n > MaxMuxFrame) throw new InvalidDataException("Invalid Node mux frame size");
            byte[] b = await ReadExactAsync(stream, (int)n, cancellation).ConfigureAwait(false); if (b == null) throw new EndOfStreamException();
            Dictionary<string, object> msg = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(b));
            ExactMux(msg);
            string peer = (string)msg["peer"];
            Peer endpoint;
            if (!Peers.TryGetValue(peer, out endpoint)) throw new InvalidDataException("Node addressed an unknown pipe peer");
            string type = (string)msg["type"];
            if (type == "data") {
                string encoded = (string)msg["bytes"];
                byte[] data = Convert.FromBase64String(encoded);
                if (data.Length == 0 || data.Length > ChunkBytes || Convert.ToBase64String(data) != encoded) throw new InvalidDataException("Node returned malformed or oversized peer data");
                lock (endpoint.WriteLock) {
                    if (!endpoint.Closed) {
                        try { endpoint.Stream.Write(data, 0, data.Length); }
                        catch (IOException) { MarkKnownPeerClosing(endpoint, peer); }
                        catch (ObjectDisposedException) { MarkKnownPeerClosing(endpoint, peer); }
                    }
                }
            } else if (type == "close") ClosePeer(peer, endpoint);
            else throw new InvalidDataException("Unexpected Node mux response type");
        }
    }
    static void ExactMux(Dictionary<string, object> msg) {
        if (msg == null || !msg.ContainsKey("v") || Convert.ToInt32(msg["v"]) != 1 || !msg.ContainsKey("type") || !msg.ContainsKey("peer")) throw new InvalidDataException("Malformed Node mux frame");
        string type = msg["type"] as string, peer = msg["peer"] as string;
        if (String.IsNullOrEmpty(peer) || peer.Length > 64 || (type != "data" && type != "close") || (type == "data" && (msg.Count != 4 || !(msg["bytes"] is string))) || (type == "close" && msg.Count != 3)) throw new InvalidDataException("Invalid Node mux frame fields");
    }
    const int MaxTrackedPeers = 64;
    static void RemoveClosedPeer(string id, Peer peer) {
        Peer current;
        if (Peers.TryGetValue(id, out current) && Object.ReferenceEquals(current, peer)) Peers.TryRemove(id, out current);
    }
    static void MarkKnownPeerClosing(Peer peer, string id) {
        lock (peer.CloseLock) peer.Closed = true;
        try { peer.Stream.Dispose(); } catch { }
    }
    static void ClosePeer(string id, Peer peer) {
        bool acknowledge = false, complete;
        lock (peer.CloseLock) {
            peer.RemoteCloseReceived = true; peer.Closed = true;
            if (!peer.LocalCloseSent) { peer.LocalCloseSent = true; acknowledge = true; }
            complete = peer.LocalCloseSent && peer.RemoteCloseReceived;
        }
        lock (peer.WriteLock) { try { peer.Stream.Dispose(); } catch { } }
        if (acknowledge) WriteMux(broker, new { v = 1, type = "close", peer = id });
        if (complete) RemoveClosedPeer(id, peer);
    }
    static async Task PipePeer(NamedPipeServerStream pipe, CancellationToken cancel) {
        string id = Guid.NewGuid().ToString("N");
        Peer peer = new Peer { Stream = pipe };
        lock (PeerSetLock) {
            if (Peers.Count >= MaxTrackedPeers) { pipe.Dispose(); return; }
            if (!Peers.TryAdd(id, peer)) { pipe.Dispose(); throw new InvalidOperationException("Duplicate peer ID"); }
        }
        WriteMux(broker, new { v = 1, type = "open", peer = id });
        byte[] buffer = new byte[ChunkBytes];
        try {
            while (!cancel.IsCancellationRequested) {
                int n = await pipe.ReadAsync(buffer, 0, buffer.Length, cancel).ConfigureAwait(false);
                if (n == 0) break;
                byte[] chunk = new byte[n]; Buffer.BlockCopy(buffer, 0, chunk, 0, n);
                WriteMux(broker, new { v = 1, type = "data", peer = id, bytes = Convert.ToBase64String(chunk) });
            }
        } catch (OperationCanceledException) { }
        catch (IOException) { if (!peer.Closed) throw; }
        catch (ObjectDisposedException) { if (!peer.Closed) throw; }
        finally {
            bool sendClose, complete;
            lock (peer.CloseLock) {
                sendClose = !peer.LocalCloseSent;
                if (sendClose) peer.LocalCloseSent = true;
                peer.Closed = true;
                complete = peer.LocalCloseSent && peer.RemoteCloseReceived;
            }
            if (sendClose) WriteMux(broker, new { v = 1, type = "close", peer = id });
            lock (peer.WriteLock) { try { peer.Stream.Dispose(); } catch { } }
            if (complete) RemoveClosedPeer(id, peer);
        }
    }
    static int StartBroker(HostConfig config, string path) {
        broker = StartNode(config, "--broker-stdio", path);
        CancellationTokenSource stop = new CancellationTokenSource();
        Task nodeOutput = ReadNodeFrames(broker, stop.Token);
        nodeOutput.ContinueWith(task => {
            if (!broker.HasExited) {
                Console.Error.WriteLine("Node stdio relay ended unexpectedly");
                try { broker.Kill(); } catch { }
            }
        }, TaskContinuationOptions.ExecuteSynchronously);
        NamedPipeServerStream next = null;
        try {
            // FILE_FLAG_FIRST_PIPE_INSTANCE makes pre-creation/squatting fail closed.
            next = NewServer(config.pipeName, true);
            while (!broker.HasExited) {
                NamedPipeServerStream waiting = next;
                next = NewServer(config.pipeName, false);
                waiting.WaitForConnection();
                if (IsRemote(waiting.SafePipeHandle) || !IsTrustedPeer(waiting.SafePipeHandle, true)) { waiting.Dispose(); continue; }
                Task.Factory.StartNew(() => PipePeer(waiting, stop.Token), TaskCreationOptions.LongRunning).Unwrap();
            }
            throw new InvalidOperationException("Node broker exited");
        } finally {
            stop.Cancel(); try { if (next != null) next.Dispose(); } catch { }
            try { broker.StandardInput.Close(); } catch { }
            if (!broker.HasExited) broker.Kill();
            try { nodeOutput.Wait(1000); } catch { }
            broker.Dispose();
        }
    }
    static Process StartNode(HostConfig config, string mode, string configFile) {
        string arguments = QuoteArg(config.hostScript) + " " + mode + " --config " + QuoteArg(configFile);
        ProcessStartInfo info = new ProcessStartInfo(config.nodeExecutable, arguments);
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        Process child = Process.Start(info);
        child.EnableRaisingEvents = true;
        Task.Factory.StartNew(() => {
            Stream errorStream = child.StandardError.BaseStream, errorOutput = Console.OpenStandardError();
            byte[] buffer = new byte[4096]; int count;
            while ((count = errorStream.Read(buffer, 0, buffer.Length)) != 0) {
                errorOutput.Write(buffer, 0, count); errorOutput.Flush();
            }
        });
        return child;
    }
    static string QuoteArg(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes).Append(ch); slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"'); return result.ToString();
    }
    static async Task RelayStream(Stream input, Stream output) {
        byte[] buffer = new byte[ChunkBytes]; int n;
        while ((n = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
            await output.WriteAsync(buffer, 0, n).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
        }
    }
    static int StartNative(HostConfig config, string path) {
        if (Environment.GetCommandLineArgs().Length != 2 || !String.Equals(Environment.GetCommandLineArgs()[1], config.extensionOrigin, StringComparison.Ordinal))
            throw new UnauthorizedAccessException("Chrome origin argument does not match the configured extension ID");
        Process child = StartNode(config, "--native", path);
        Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
        Task toNode = Task.Factory.StartNew(async () => {
            try { await RelayStream(input, child.StandardInput.BaseStream).ConfigureAwait(false); }
            finally { child.StandardInput.Close(); }
        }).Unwrap();
        Task toChrome = Task.Factory.StartNew(() => RelayStream(child.StandardOutput.BaseStream, output)).Unwrap();
        try { Task.WaitAll(toNode, toChrome); child.WaitForExit(); return child.ExitCode; }
        finally { if (!child.HasExited) child.Kill(); child.Dispose(); }
    }
    public static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "--broker") {
                if (args.Length != 3 || args[1] != "--config" || !Path.IsPathRooted(args[2])) throw new ArgumentException("Usage: bridge-host.exe --broker --config ABSOLUTE_CONFIG");
                configPath = args[2]; return StartBroker(LoadConfig(configPath), configPath);
            }
            configPath = ConfigPathFromExe();
            HostConfig config = LoadConfig(configPath);
            return StartNative(config, configPath);
        } catch (Exception error) { Console.Error.WriteLine("browser bridge launcher: " + error); return 1; }
    }
}
