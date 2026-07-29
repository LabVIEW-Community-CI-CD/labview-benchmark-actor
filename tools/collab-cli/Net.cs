using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Wire envelope for the local TCP/UDP coordination bus (LBA-REQ-007, ADR-0003) —
/// <c>labview-benchmark-actor/bus-msg@1</c>. Mirrors the GitHub-Discussion collab semantics
/// (CLAIM/ACK/HANDOFF/DONE/PROGRESS/NOTE) so the coordination model is preserved across the transport.
/// </summary>
internal sealed record BusEnvelope
{
    [JsonPropertyName("schema")] public string Schema { get; init; } = BusWire.Schema;
    [JsonPropertyName("sessionId")] public string SessionId { get; init; } = "default";
    [JsonPropertyName("senderId")] public string SenderId { get; init; } = "";
    [JsonPropertyName("seq")] public long Seq { get; init; }
    [JsonPropertyName("ts")] public BusTimestamp Ts { get; init; } = new();
    [JsonPropertyName("type")] public string Type { get; init; } = "NOTE";
    [JsonPropertyName("task")] public string? Task { get; init; }
    [JsonPropertyName("payload")] public string? Payload { get; init; }
    [JsonPropertyName("ackOf")] public long? AckOf { get; init; }
}

internal sealed record BusTimestamp
{
    [JsonPropertyName("wall")] public string Wall { get; init; } =
        DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
    [JsonPropertyName("run")] public long? Run { get; init; }
}

/// <summary>
/// Length-prefixed JSON framing (ADR-0003 §1): a 4-byte big-endian unsigned length prefix followed by
/// exactly that many bytes of UTF-8 JSON, one envelope per frame. A per-frame max (1 MiB) fails closed on
/// a corrupt or hostile length — the bus carries only small inter-actor coordination messages.
/// </summary>
internal static class BusWire
{
    public const string Schema = "labview-benchmark-actor/bus-msg@1";
    public const int MaxFrameBytes = 1024 * 1024;

    public static readonly HashSet<string> Types =
        new(StringComparer.OrdinalIgnoreCase) { "CLAIM", "ACK", "HANDOFF", "DONE", "PROGRESS", "NOTE", "HELLO" };

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static void WriteFrame(Stream stream, BusEnvelope env)
    {
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(env, JsonOpts);
        if (json.Length > MaxFrameBytes)
        {
            throw new InvalidOperationException($"bus frame {json.Length} bytes exceeds {MaxFrameBytes} max");
        }

        Span<byte> len = stackalloc byte[4];
        BinaryPrimitivesWriteUInt32BigEndian(len, (uint)json.Length);
        stream.Write(len);
        stream.Write(json);
        stream.Flush();
    }

    /// <summary>Reads one frame; returns null on a clean EOF before any bytes.</summary>
    public static BusEnvelope? ReadFrame(Stream stream)
    {
        byte[] lenBuf = new byte[4];
        int got = ReadExact(stream, lenBuf, 0, 4);
        if (got == 0)
        {
            return null; // clean EOF
        }

        if (got < 4)
        {
            throw new InvalidOperationException("truncated length prefix");
        }

        uint length = (uint)((lenBuf[0] << 24) | (lenBuf[1] << 16) | (lenBuf[2] << 8) | lenBuf[3]);
        if (length == 0 || length > MaxFrameBytes)
        {
            throw new InvalidOperationException($"bus frame length {length} out of range (1..{MaxFrameBytes}) — fail closed");
        }

        byte[] payload = new byte[length];
        if (ReadExact(stream, payload, 0, (int)length) != (int)length)
        {
            throw new InvalidOperationException("truncated frame body");
        }

        return JsonSerializer.Deserialize<BusEnvelope>(payload, JsonOpts);
    }

    public static byte[] EncodeDatagram(BusEnvelope env) => JsonSerializer.SerializeToUtf8Bytes(env, JsonOpts);

    public static BusEnvelope? DecodeDatagram(byte[] data, int length)
    {
        try { return JsonSerializer.Deserialize<BusEnvelope>(data.AsSpan(0, length), JsonOpts); }
        catch { return null; }
    }

    public static string Render(BusEnvelope e)
    {
        string task = e.Task is null ? "" : $" task:{e.Task}";
        string ack = e.AckOf is null ? "" : $" ackOf:{e.AckOf}";
        string body = e.Payload is null ? "" : " — " + (e.Payload.Length <= 400 ? e.Payload : e.Payload[..400] + "…");
        return $"[{e.Ts.Wall}] {e.SenderId} #{e.Seq} {e.Type}{task}{ack}{body}";
    }

    private static int ReadExact(Stream s, byte[] buf, int offset, int count)
    {
        int total = 0;
        while (total < count)
        {
            int n = s.Read(buf, offset + total, count - total);
            if (n == 0)
            {
                break;
            }

            total += n;
        }

        return total;
    }

    private static void BinaryPrimitivesWriteUInt32BigEndian(Span<byte> dst, uint value)
    {
        dst[0] = (byte)(value >> 24);
        dst[1] = (byte)(value >> 16);
        dst[2] = (byte)(value >> 8);
        dst[3] = (byte)value;
    }
}

/// <summary>
/// The <c>lbabus net</c> subsystem: a headless local TCP/UDP coordination bus (LBA-REQ-007, ADR-0003/0004)
/// that mirrors the GitHub-Discussion collab semantics, so an agent (e.g. inside a clean-room VM) can talk
/// to another over the private network with no github.com dependency. Bind loopback or the private Vagrant
/// network by default; never expose publicly.
/// </summary>
internal static class NetCommands
{
    public static int Run(string[] tail)
    {
        if (tail.Length == 0)
        {
            Console.Error.WriteLine("lbabus net: subcommand required — listen | send | beacon | ping");
            return 1;
        }

        string sub = tail[0].ToLowerInvariant();
        var a = new ArgMap(tail.Skip(1));
        return sub switch
        {
            "listen" or "serve" => CmdListen(a),
            "send" => CmdSend(a),
            "beacon" => CmdBeacon(a),
            "ping" => CmdPing(a),
            _ => Fail($"unknown net subcommand '{sub}'"),
        };
    }

    private static string SenderId() => Config.FromEnvironment().Agent;

    private static int? IntOrNull(ArgMap a, string key) =>
        a.Get(key) is { } s && int.TryParse(s, out int v) ? v : null;

    /// <summary>Headless listener/collector: prints every received TCP frame + UDP beacon (troubleshooting).</summary>
    private static int CmdListen(ArgMap a)
    {
        int? tcpPort = IntOrNull(a, "tcp");
        int? udpPort = IntOrNull(a, "udp");
        string bindStr = a.Get("bind") ?? "0.0.0.0";
        bool echo = a.Get("echo") is not null;
        int count = a.GetInt("count", 0); // 0 = unbounded
        int timeoutSec = a.GetInt("timeout", 0); // 0 = no timeout
        string session = a.Get("session") ?? "default";

        if (tcpPort is null && udpPort is null)
        {
            tcpPort = 7420;
        }

        IPAddress bind = IPAddress.TryParse(bindStr, out IPAddress? ip) ? ip : IPAddress.Any;
        DateTimeOffset deadline = timeoutSec > 0 ? DateTimeOffset.UtcNow.AddSeconds(timeoutSec) : DateTimeOffset.MaxValue;
        int received = 0;
        var stop = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Set(); };

        Console.Error.WriteLine($"[net] listen session={session} bind={bind} tcp={(tcpPort?.ToString() ?? "-")} udp={(udpPort?.ToString() ?? "-")} echo={echo} count={(count == 0 ? "∞" : count.ToString())}");

        TcpListener? tcp = null;
        UdpClient? udp = null;
        var threads = new List<Thread>();

        if (tcpPort is int tp)
        {
            tcp = new TcpListener(bind, tp);
            tcp.Start();
            var t = new Thread(() =>
            {
                try
                {
                    while (!stop.IsSet)
                    {
                        if (!tcp.Server.Poll(200_000, SelectMode.SelectRead))
                        {
                            if (DateTimeOffset.UtcNow > deadline) { stop.Set(); }
                            continue;
                        }

                        TcpClient client = tcp.AcceptTcpClient();
                        HandleTcpClient(client, echo, ref received, count, stop);
                    }
                }
                catch (SocketException) { }
                catch (ObjectDisposedException) { }
            })
            { IsBackground = true };
            t.Start();
            threads.Add(t);
        }

        if (udpPort is int up)
        {
            udp = new UdpClient(new IPEndPoint(bind, up));
            var t = new Thread(() =>
            {
                var remote = new IPEndPoint(IPAddress.Any, 0);
                udp.Client.ReceiveTimeout = 500;
                while (!stop.IsSet)
                {
                    try
                    {
                        byte[] data = udp.Receive(ref remote);
                        BusEnvelope? env = BusWire.DecodeDatagram(data, data.Length);
                        if (env is not null)
                        {
                            Console.WriteLine($"UDP {remote.Address}  {BusWire.Render(env)}");
                            if (Interlocked.Increment(ref received) >= count && count > 0) { stop.Set(); }
                        }
                    }
                    catch (SocketException) { if (DateTimeOffset.UtcNow > deadline) { stop.Set(); } }
                    catch (ObjectDisposedException) { break; }
                }
            })
            { IsBackground = true };
            t.Start();
            threads.Add(t);
        }

        stop.Wait();
        tcp?.Stop();
        udp?.Dispose();
        foreach (Thread t in threads) { t.Join(500); }
        Console.Error.WriteLine($"[net] listener stopped; received {received} message(s)");
        return 0;
    }

    private static void HandleTcpClient(TcpClient client, bool echo, ref int received, int count, ManualResetEventSlim stop)
    {
        using (client)
        {
            client.NoDelay = true;
            using NetworkStream ns = client.GetStream();
            EndPoint? remote = client.Client.RemoteEndPoint;
            while (!stop.IsSet)
            {
                BusEnvelope? env;
                try { env = BusWire.ReadFrame(ns); }
                catch (Exception ex) { Console.Error.WriteLine($"[net] TCP frame error from {remote}: {ex.Message}"); break; }

                if (env is null) { break; } // peer closed

                Console.WriteLine($"TCP {remote}  {BusWire.Render(env)}");
                int n = Interlocked.Increment(ref received);

                if (echo)
                {
                    var ack = new BusEnvelope
                    {
                        SessionId = env.SessionId,
                        SenderId = SenderId(),
                        Seq = n,
                        Type = "ACK",
                        Task = env.Task,
                        AckOf = env.Seq,
                        Payload = $"received {env.Type} from {env.SenderId}",
                    };
                    try { BusWire.WriteFrame(ns, ack); } catch { /* peer gone */ }
                }

                if (count > 0 && n >= count) { stop.Set(); break; }
            }
        }
    }

    /// <summary>
    /// Fans a single invocation out to a peer LIST via <c>--hosts &lt;csv&gt;</c> (or one <c>--host</c>, back-compat).
    /// Using one process per actor per transport keeps the mesh proof at O(N) process launches instead of the
    /// per-(peer×transport) O(N²) fork model, so a scale run measures the transport, not dotnet startup contention.
    /// </summary>
    private static IReadOnlyList<string> HostList(ArgMap a, string singleDefault)
    {
        if (a.Get("hosts") is { } csv)
        {
            string[] list = csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (list.Length > 0) { return list; }
        }

        return new[] { a.Get("host") ?? singleDefault };
    }

    /// <summary>Sends one reliable, ordered TCP frame to each target (claim/handoff/ack/done/progress/note).</summary>
    private static int CmdSend(ArgMap a)
    {
        IReadOnlyList<string> hosts = HostList(a, "127.0.0.1");
        int port = a.GetInt("tcp", a.GetInt("port", 7420));
        string type = (a.Get("type") ?? "NOTE").ToUpperInvariant();
        if (!BusWire.Types.Contains(type)) { return Fail($"invalid --type '{type}'. Valid: {string.Join(", ", BusWire.Types)}"); }

        string? message = a.Get("message");
        if (message is null && a.Get("message-file") is { } mf) { message = File.ReadAllText(mf); }

        int awaitSec = a.GetInt("await", 3);
        int retries = a.GetInt("retries", 1);       // per-host connect attempts (1 = single try, back-compat)
        int retryMs = a.GetInt("retry-ms", 1000);

        var env = new BusEnvelope
        {
            SessionId = a.Get("session") ?? "default",
            SenderId = SenderId(),
            Seq = a.GetInt("seq", (int)(DateTimeOffset.UtcNow.ToUnixTimeSeconds() % int.MaxValue)),
            Type = type,
            Task = a.Get("task"),
            Payload = message,
            AckOf = IntOrNull(a, "ackof"),
        };

        int failures = 0;
        foreach (string host in hosts)
        {
            if (!SendOne(host, port, env, awaitSec, retries, retryMs)) { failures++; }
        }

        if (failures > 0) { return Fail($"TCP send failed to {failures}/{hosts.Count} host(s)"); }
        return 0;
    }

    /// <summary>Connects (with optional retry-until-listening) and writes one frame to a single host.</summary>
    private static bool SendOne(string host, int port, BusEnvelope env, int awaitSec, int retries, int retryMs)
    {
        for (int attempt = 1; attempt <= retries; attempt++)
        {
            try
            {
                using var client = new TcpClient();
                client.Connect(host, port);
                client.NoDelay = true;
                using NetworkStream ns = client.GetStream();
                BusWire.WriteFrame(ns, env);
                Console.WriteLine($"sent -> {host}:{port}  {BusWire.Render(env)}");

                // Await an optional echoed ACK (short timeout).
                ns.ReadTimeout = awaitSec * 1000;
                try
                {
                    BusEnvelope? reply = BusWire.ReadFrame(ns);
                    if (reply is not null) { Console.WriteLine($"reply <- {host}:{port}  {BusWire.Render(reply)}"); }
                }
                catch (IOException) { /* no reply within timeout — fine */ }

                return true;
            }
            catch (SocketException ex)
            {
                if (attempt >= retries)
                {
                    Console.Error.WriteLine($"[net] TCP connect {host}:{port} failed after {attempt} attempt(s): {ex.Message}");
                    return false;
                }

                Thread.Sleep(retryMs);
            }
        }

        return false;
    }

    /// <summary>
    /// Emits UDP presence/liveness beacons (ADR-0004): low-latency, loss-safe, advisory. Fans out to a peer
    /// LIST via <c>--hosts &lt;csv&gt;</c> (or one <c>--host</c>). Each target accepts a literal IP OR a name —
    /// names are DNS-resolved to IPv4 here, so mesh scripts no longer need to pre-resolve before beaconing.
    /// </summary>
    private static int CmdBeacon(ArgMap a)
    {
        IReadOnlyList<string> hosts = HostList(a, "255.255.255.255");
        int port = a.GetInt("udp", a.GetInt("port", 7421));
        double interval = a.GetInt("interval", 1);
        int count = a.GetInt("count", 5);
        string session = a.Get("session") ?? "default";

        var targets = new List<(string Host, IPEndPoint Ep)>();
        bool broadcast = false;
        foreach (string host in hosts)
        {
            IPAddress addr;
            try { addr = ResolveHost(host); }
            catch (Exception ex) { return Fail($"UDP beacon cannot resolve '{host}': {ex.Message}"); }
            if (host is "255.255.255.255") { broadcast = true; }
            targets.Add((host, new IPEndPoint(addr, port)));
        }

        try
        {
            using var udp = new UdpClient();
            if (broadcast) { udp.EnableBroadcast = true; }

            for (int i = 1; i <= count || count == 0; i++)
            {
                foreach ((string host, IPEndPoint ep) in targets)
                {
                    var env = new BusEnvelope
                    {
                        SessionId = session,
                        SenderId = SenderId(),
                        Seq = i,
                        Type = "PROGRESS",
                        Task = a.Get("task") ?? "presence",
                        Payload = a.Get("message") ?? $"{SenderId()} present",
                    };
                    byte[] data = BusWire.EncodeDatagram(env);
                    udp.Send(data, data.Length, ep);
                    Console.WriteLine($"beacon -> {host}:{port}  {BusWire.Render(env)}");
                }

                if (i < count || count == 0) { Thread.Sleep((int)(interval * 1000)); }
            }

            return 0;
        }
        catch (SocketException ex)
        {
            return Fail($"UDP beacon failed: {ex.Message}");
        }
    }

    /// <summary>Resolves a beacon target: <c>localhost</c>/literal IP as-is, otherwise DNS to the first IPv4.</summary>
    private static IPAddress ResolveHost(string host)
    {
        if (host is "localhost") { return IPAddress.Loopback; }
        if (IPAddress.TryParse(host, out IPAddress? ip)) { return ip; }

        IPAddress[] addrs = Dns.GetHostAddresses(host);
        foreach (IPAddress candidate in addrs)
        {
            if (candidate.AddressFamily == AddressFamily.InterNetwork) { return candidate; }
        }

        if (addrs.Length > 0) { return addrs[0]; }
        throw new InvalidOperationException("no addresses resolved");
    }

    /// <summary>Reachability probe: TCP-connect, send a NOTE, await an echoed frame; reports RTT.</summary>
    private static int CmdPing(ArgMap a)
    {
        string host = a.Get("host") ?? "127.0.0.1";
        int port = a.GetInt("tcp", a.GetInt("port", 7420));
        int timeout = a.GetInt("timeout", 5);

        var env = new BusEnvelope
        {
            SessionId = a.Get("session") ?? "default",
            SenderId = SenderId(),
            Seq = 1,
            Type = "NOTE",
            Task = "ping",
            Payload = a.Get("message") ?? "ping",
        };

        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var client = new TcpClient();
            var connect = client.BeginConnect(host, port, null, null);
            if (!connect.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(timeout)))
            {
                return Fail($"ping {host}:{port} timed out after {timeout}s (no TCP connect)");
            }

            client.EndConnect(connect);
            using NetworkStream ns = client.GetStream();
            BusWire.WriteFrame(ns, env);
            ns.ReadTimeout = timeout * 1000;
            try
            {
                BusEnvelope? reply = BusWire.ReadFrame(ns);
                sw.Stop();
                Console.WriteLine(reply is not null
                    ? $"pong <- {host}:{port} in {sw.ElapsedMilliseconds}ms  {BusWire.Render(reply)}"
                    : $"connected {host}:{port} in {sw.ElapsedMilliseconds}ms (peer sent no reply)");
                return 0;
            }
            catch (IOException)
            {
                sw.Stop();
                Console.WriteLine($"connected {host}:{port} in {sw.ElapsedMilliseconds}ms (no reply within {timeout}s)");
                return 0;
            }
        }
        catch (SocketException ex)
        {
            return Fail($"ping {host}:{port} failed: {ex.Message}");
        }
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("lbabus net: " + message);
        return 1;
    }
}
