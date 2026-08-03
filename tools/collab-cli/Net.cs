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

    // Envelope types. The base coordination set (CLAIM/ACK/HANDOFF/DONE/PROGRESS/NOTE/HELLO) plus the
    // semantic reviewer-verdict statuses (RESOLVED/REFINE/BLOCKED) so a signed verdict announces over
    // `net` with a first-class semantic type (ADR-0039, LBA-REQ-059) -- coordination is net-only, off
    // the GitHub-Discussion bus (ADR-0047).
    public static readonly HashSet<string> Types =
        new(StringComparer.OrdinalIgnoreCase)
        { "CLAIM", "ACK", "HANDOFF", "DONE", "PROGRESS", "NOTE", "HELLO", "RESOLVED", "REFINE", "BLOCKED" };

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Serialize an envelope to a single-line JSON string (the wire + receive-log encoding).</summary>
    internal static string ToJson(BusEnvelope e) => JsonSerializer.Serialize(e, JsonOpts);

    /// <summary>Parse one receive-log JSON line back to an envelope; returns null on malformed JSON (fail-safe).</summary>
    internal static BusEnvelope? FromJson(string s)
    {
        try { return JsonSerializer.Deserialize<BusEnvelope>(s, JsonOpts); }
        catch (JsonException) { return null; }
    }

    public static void WriteFrame(Stream stream, BusEnvelope env, bool flush = true)
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
        if (flush) { stream.Flush(); }
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
            Console.Error.WriteLine("lbabus net: subcommand required — listen | send | poll | beacon | ping");
            return 1;
        }

        string sub = tail[0].ToLowerInvariant();
        var a = new ArgMap(tail.Skip(1));
        return sub switch
        {
            "listen" or "serve" => CmdListen(a),
            "send" => CmdSend(a),
            "poll" => CmdPoll(a),
            "beacon" => CmdBeacon(a),
            "ping" => CmdPing(a),
            _ => Fail($"unknown net subcommand '{sub}'"),
        };
    }

    private static string SenderId() => Config.FromEnvironment().Agent;

    private static int? IntOrNull(ArgMap a, string key) =>
        a.Get(key) is { } s && int.TryParse(s, out int v) ? v : null;

    private static readonly object LogLock = new();

    /// <summary>
    /// Append a received frame to the per-actor local receive-log (JSONL). This is the LIVE-ONLY coordination
    /// store (ADR-0040, LBA-REQ-060): each actor's `net listen --log` daemon records what it heard while online;
    /// `net poll` reads it. There is no central/async store -- a peer offline at post time simply misses the
    /// frame. Best-effort: a log error is reported but never breaks the listener.
    /// </summary>
    private static void AppendLog(string? path, BusEnvelope env)
    {
        if (string.IsNullOrEmpty(path)) { return; }
        try { lock (LogLock) { File.AppendAllText(path, BusWire.ToJson(env) + "\n"); } }
        catch (Exception ex) { Console.Error.WriteLine($"[net] receive-log append failed: {ex.Message}"); }
    }

    /// <summary>
    /// `net poll` -- read the local receive-log written by `net listen --log` and print the last N frames
    /// (optionally filtered by --type / --task), mirroring the Discussion `poll` UX over the TCP bus. Live-only:
    /// with no log (never listened / nothing heard) it prints nothing and exits 0. This is the read side of the
    /// off-GitHub-Discussions coordination model (ADR-0040, LBA-REQ-060).
    /// </summary>
    private static int CmdPoll(ArgMap a)
    {
        string? logPath = a.Get("log") ?? Environment.GetEnvironmentVariable("VIHS_COLLAB_NET_LOG");
        int tail = a.GetInt("tail", 10);
        string? type = a.Get("type");
        string? task = a.Get("task");
        if (string.IsNullOrEmpty(logPath)) { Console.Error.WriteLine("[net poll] no receive-log configured (set busNetLog / VIHS_COLLAB_NET_LOG) -- nothing to poll (live-only default, ADR-0045)"); return 0; }
        if (!File.Exists(logPath)) { Console.Error.WriteLine($"[net poll] no local receive-log at {logPath} -- nothing heard yet (live-only, ADR-0040)"); return 0; }
        var frames = new List<BusEnvelope>();
        foreach (string line in File.ReadLines(logPath))
        {
            if (string.IsNullOrWhiteSpace(line)) { continue; }
            BusEnvelope? env = BusWire.FromJson(line);
            if (env is null) { continue; }
            if (type is not null && !string.Equals(env.Type, type, StringComparison.OrdinalIgnoreCase)) { continue; }
            if (task is not null && !string.Equals(env.Task, task, StringComparison.Ordinal)) { continue; }
            frames.Add(env);
        }
        foreach (BusEnvelope env in frames.Skip(Math.Max(0, frames.Count - tail)))
        {
            Console.WriteLine(BusWire.Render(env));
        }
        return 0;
    }

    /// <summary>Headless listener/collector: prints every received TCP frame + UDP beacon (troubleshooting).</summary>
    private static int CmdListen(ArgMap a)
    {
        int? tcpPort = IntOrNull(a, "tcp");
        int? udpPort = IntOrNull(a, "udp");
        string bindStr = a.Get("bind") ?? "0.0.0.0";
        bool echo = a.Get("echo") is not null;
        int count = a.GetInt("count", 0); // 0 = unbounded
        int countDistinct = a.GetInt("count-distinct", 0); // 0 = disabled; else stop once N distinct peers heard
        int timeoutSec = a.GetInt("timeout", 0); // 0 = no timeout
        string session = a.Get("session") ?? "default";
        string? logPath = a.Get("log"); // append received frames to a local JSONL receive-log (live-only coordination, ADR-0040)

        if (tcpPort is null && udpPort is null)
        {
            tcpPort = 7420;
        }

        IPAddress bind = IPAddress.TryParse(bindStr, out IPAddress? ip) ? ip : IPAddress.Any;
        DateTimeOffset deadline = timeoutSec > 0 ? DateTimeOffset.UtcNow.AddSeconds(timeoutSec) : DateTimeOffset.MaxValue;
        int received = 0;
        string self = SenderId();
        var distinct = new System.Collections.Concurrent.ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        var stop = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Set(); };

        Console.Error.WriteLine($"[net] listen session={session} bind={bind} tcp={(tcpPort?.ToString() ?? "-")} udp={(udpPort?.ToString() ?? "-")} echo={echo} count={(count == 0 ? "∞" : count.ToString())} count-distinct={(countDistinct == 0 ? "-" : countDistinct.ToString())}");

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
                        HandleTcpClient(client, echo, ref received, count, stop, distinct, countDistinct, self, logPath);
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
            TryGrowReceiveBuffer(udp); // larger SO_RCVBUF so a burst of presence beacons at mesh scale is less lossy
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
                            AppendLog(logPath, env);
                            int n = Interlocked.Increment(ref received);
                            if (count > 0 && n >= count) { stop.Set(); }
                            if (NoteDistinct(distinct, countDistinct, self, env.SenderId)) { stop.Set(); }
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
        Console.Error.WriteLine($"[net] listener stopped; received {received} message(s) from {distinct.Count} distinct sender(s)");
        return 0;
    }

    /// <summary>
    /// Records a sender identity (excluding our own) toward the optional <c>--count-distinct N</c> early-exit,
    /// returning true once N distinct peers have been heard. This lets a UDP presence listener stop the instant
    /// it has heard every expected peer instead of always blocking for the full <c>--timeout</c> — removing the
    /// timeout-vs-latency tradeoff that dropped late beacons in a large mesh (a short timeout expired before the
    /// mesh finished forming; a long one is slow). Identity-based, so it is robust to datagram loss and SNAT.
    /// </summary>
    private static bool NoteDistinct(
        System.Collections.Concurrent.ConcurrentDictionary<string, byte> distinct,
        int countDistinct, string self, string senderId)
    {
        if (countDistinct <= 0) { return false; }
        if (string.IsNullOrEmpty(senderId) || string.Equals(senderId, self, StringComparison.Ordinal)) { return false; }
        distinct.TryAdd(senderId, 0);
        return distinct.Count >= countDistinct;
    }

    /// <summary>Best-effort enlarge of the UDP receive buffer so a burst of beacons at mesh scale is less likely dropped by a full socket buffer; the OS clamps to its own max.</summary>
    private static void TryGrowReceiveBuffer(UdpClient udp)
    {
        try { udp.Client.ReceiveBufferSize = 1 << 20; } // 1 MiB
        catch (SocketException) { /* platform clamps to its max — best effort */ }
        catch (ObjectDisposedException) { }
    }

    private static void HandleTcpClient(TcpClient client, bool echo, ref int received, int count, ManualResetEventSlim stop,
        System.Collections.Concurrent.ConcurrentDictionary<string, byte> distinct, int countDistinct, string self, string? logPath)
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
                AppendLog(logPath, env);
                int n = Interlocked.Increment(ref received);
                bool distinctDone = NoteDistinct(distinct, countDistinct, self, env.SenderId);

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

                if ((count > 0 && n >= count) || distinctDone) { stop.Set(); break; }
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
        // Graceful no-op for an unconfigured net-default actor (ADR-0045): with --skip-if-no-peer and no
        // explicit --hosts/--host, there is no peer to announce to -- skip cleanly (exit 0) instead of a dead
        // loopback attempt. Callers set this when on the net transport but no busNetHosts is configured.
        if (a.Get("skip-if-no-peer") is not null && a.Get("hosts") is null && a.Get("host") is null)
        {
            Console.Error.WriteLine("[net send] no peer configured (set busNetHosts / VIHS_COLLAB_NET_HOSTS) -- skipping the announce (live-only default, ADR-0045)");
            return 0;
        }
        IReadOnlyList<string> hosts = HostList(a, "127.0.0.1");
        int port = a.GetInt("tcp", a.GetInt("port", 7420));
        string type = (a.Get("type") ?? "NOTE").ToUpperInvariant();
        if (!BusWire.Types.Contains(type)) { return Fail($"invalid --type '{type}'. Valid: {string.Join(", ", BusWire.Types)}"); }

        // --stream: persistent connection, MULTI-FRAME. ONE TCP connection carries --count N seq'd frames
        // (seq S..S+N-1) + an optional terminal DONE(S+N-1), with a single bulk flush -- amortizing the
        // process spawn + connect + per-frame flush of the one-frame model so a source can drive the bus at
        // transport/disk speed instead of ~O(100) frames/s. Preserves the bus-msg@1 framing + strict seq order.
        if (a.Get("stream") is not null) { return SendStream(a, hosts, port, type); }

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
    /// Persistent-connection, multi-frame streaming send: opens ONE TCP connection per host and streams
    /// <c>--count N</c> frames (seq <c>--seq</c> S .. S+N-1), each a real bus-msg@1 envelope, then an optional
    /// terminal DONE(S+N-1) with <c>--done</c>. A single bulk flush (no per-frame flush/connect) lets a source
    /// drive the bus at transport/disk speed. Payload is <c>--message</c> or <c>--frame-bytes B</c> filler.
    /// </summary>
    private static int SendStream(ArgMap a, IReadOnlyList<string> hosts, int port, string type)
    {
        int count = a.GetInt("count", 0);
        if (count <= 0) { return Fail("--stream requires --count N (frames to stream)"); }
        int seqStart = a.GetInt("seq", 1);
        int frameBytes = a.GetInt("frame-bytes", 0);
        bool done = a.Get("done") is not null;
        int retries = a.GetInt("retries", 1);
        int retryMs = a.GetInt("retry-ms", 1000);
        string session = a.Get("session") ?? "default";
        string sender = SenderId();
        string? task = a.Get("task");
        string? message = a.Get("message");
        if (message is null && a.Get("message-file") is { } mf) { message = File.ReadAllText(mf); }
        string? payload = frameBytes > 0 ? new string('x', frameBytes) : message;

        int failures = 0;
        foreach (string host in hosts)
        {
            if (!StreamOne(host, port, session, sender, type, task, payload, seqStart, count, done, retries, retryMs)) { failures++; }
        }
        if (failures > 0) { return Fail($"stream failed to {failures}/{hosts.Count} host(s)"); }
        return 0;
    }

    /// <summary>Streams N frames (+ optional terminal DONE) over ONE persistent connection to a single host.</summary>
    private static bool StreamOne(string host, int port, string session, string sender, string type, string? task,
        string? payload, int seqStart, int count, bool done, int retries, int retryMs)
    {
        for (int attempt = 1; attempt <= retries; attempt++)
        {
            try
            {
                using var client = new TcpClient();
                client.Connect(host, port);
                client.NoDelay = true;
                client.SendBufferSize = 1 << 22;
                using NetworkStream ns = client.GetStream();
                using var buffered = new BufferedStream(ns, 1 << 20);
                var t0 = DateTime.UtcNow;
                for (int i = 0; i < count; i++)
                {
                    var env = new BusEnvelope { SessionId = session, SenderId = sender, Seq = seqStart + i, Type = type, Task = task, Payload = payload };
                    BusWire.WriteFrame(buffered, env, flush: false);
                }
                if (done)
                {
                    var doneEnv = new BusEnvelope { SessionId = session, SenderId = sender, Seq = seqStart + count - 1, Type = "DONE", Task = task, Payload = $"final={count}" };
                    BusWire.WriteFrame(buffered, doneEnv, flush: false);
                }
                buffered.Flush();
                double secs = Math.Max((DateTime.UtcNow - t0).TotalSeconds, 1e-9);
                long payloadBytes = (long)(payload?.Length ?? 0) * count;
                Console.WriteLine($"stream -> {host}:{port}  frames={count}{(done ? "+DONE" : "")} seq={seqStart}..{seqStart + count - 1} " +
                    $"payloadBytes={payloadBytes} secs={secs:F3} kfps={count / secs / 1000:F1} payloadMBps={payloadBytes / secs / (1 << 20):F1}");
                return true;
            }
            catch (SocketException ex)
            {
                if (attempt >= retries) { Console.Error.WriteLine($"[net] TCP connect {host}:{port} failed after {attempt} attempt(s): {ex.Message}"); return false; }
                Thread.Sleep(retryMs);
            }
            catch (IOException ex)
            {
                Console.Error.WriteLine($"[net] TCP stream to {host}:{port} failed: {ex.Message}");
                return false;
            }
        }
        return false;
    }

    /// <summary>
    /// Emits UDP presence/liveness beacons (ADR-0004): low-latency, loss-safe, advisory. Fans out to a peer
    /// LIST via <c>--hosts &lt;csv&gt;</c> (or one <c>--host</c>). Each target accepts a literal IP OR a name —
    /// names are DNS-resolved to IPv4 here, so mesh scripts no longer need to pre-resolve before beaconing.
    /// <c>--bind &lt;ip&gt;</c> pins the SOURCE NIC (e.g. the host-only mesh <c>192.168.56.x</c>) instead of the
    /// route the OS would pick (often the NAT default route); a subnet-directed target (<c>192.168.56.255</c>)
    /// or explicit <c>--broadcast</c> enables SO_BROADCAST so presence can ride a CHOSEN subnet.
    /// </summary>
    private static int CmdBeacon(ArgMap a)
    {
        IReadOnlyList<string> hosts = HostList(a, "255.255.255.255");
        int port = a.GetInt("udp", a.GetInt("port", 7421));
        double interval = a.GetInt("interval", 1);
        int count = a.GetInt("count", 5);
        string session = a.Get("session") ?? "default";

        // --bind <ip>: pin the SOURCE interface so beacons egress a CHOSEN NIC (e.g. the host-only mesh
        // 192.168.56.x) instead of whatever the routing table picks (often the NAT default route). Mirrors
        // `net listen --bind`. Unset => OS chooses the source by the destination route (fine for unicast).
        string bindStr = a.Get("bind") ?? "";
        IPAddress? bindIp = null;
        if (bindStr.Length > 0 && !IPAddress.TryParse(bindStr, out bindIp))
        {
            return Fail($"--bind: invalid IP '{bindStr}'");
        }

        // SO_BROADCAST is needed for any broadcast. Enable it for an explicit --broadcast, the limited
        // broadcast 255.255.255.255, OR a SUBNET-DIRECTED broadcast (a target ending in .255, e.g.
        // 192.168.56.255 to reach the host-only mesh only) — previously only the literal 255.255.255.255,
        // which egresses the NAT default route rather than the intended subnet.
        bool broadcast = a.Get("broadcast") is not null
            || hosts.Any(h => h is "255.255.255.255" || h.EndsWith(".255", StringComparison.Ordinal));

        try
        {
            using var udp = bindIp is not null ? new UdpClient(new IPEndPoint(bindIp, 0)) : new UdpClient();
            if (broadcast) { udp.EnableBroadcast = true; }
            Console.Error.WriteLine($"[net] beacon bind={(bindIp?.ToString() ?? "auto")} udp={port} broadcast={broadcast} hosts={string.Join(",", hosts)} count={(count == 0 ? "∞" : count.ToString())}");

            for (int i = 1; i <= count || count == 0; i++)
            {
                foreach (string host in hosts)
                {
                    // Resolve + send PER HOST inside ONE try: presence beacons are advisory + loss-safe
                    // (ADR-0004), so a transient DNS miss OR a per-host send error (e.g. an unreachable
                    // directed-broadcast subnet, or one down peer) skips only THAT peer this round rather
                    // than aborting the whole fan-out; a name/route that hiccups is retried next round.
                    try
                    {
                        IPAddress addr = ResolveHost(host);
                        var ep = new IPEndPoint(addr, port);
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
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[net] UDP beacon skip '{host}' (round {i}): {ex.Message}");
                        continue;
                    }
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
