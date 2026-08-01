// tpd -- throughput-to-disk harness for the mesh source concept. Measures how fast a SINK can land received
// bytes ON DISK, under different SOURCE emit strategies, so we can drive the design to its disk/wire/CPU
// plateau. Matches lbabus's .NET stack. NOT part of the product -- a benchmark harness (experiments/).
//
//   tpd sink   --transport tcp|udp|mcast --port P --out FILE|--discard --bytes TOTAL [--fsync] [--group G]
//   tpd source --transport tcp|udp|mcast --host H --port P --frame B --bytes TOTAL [--conns N] [--group G]
//
// The SINK is authoritative for "throughput to disk" (bytes written / elapsed from first to last byte).
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Tpd
{
    internal static class Program
    {
        private static string Arg(string[] a, string k, string d = null)
        {
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == k) return a[i + 1];
            return d;
        }
        private static bool Flag(string[] a, string k) { foreach (var x in a) if (x == k) return true; return false; }
        private static long Bytes(string s)
        {
            if (string.IsNullOrEmpty(s)) return 0;
            s = s.Trim().ToUpperInvariant();
            long mul = 1;
            if (s.EndsWith("G")) { mul = 1L << 30; s = s[..^1]; }
            else if (s.EndsWith("M")) { mul = 1L << 20; s = s[..^1]; }
            else if (s.EndsWith("K")) { mul = 1L << 10; s = s[..^1]; }
            return (long)(double.Parse(s) * mul);
        }

        private static int Main(string[] args)
        {
            if (args.Length == 0) { Console.Error.WriteLine("usage: tpd sink|source ..."); return 2; }
            try
            {
                switch (args[0])
                {
                    case "sink": return Sink(args);
                    case "source": return Source(args);
                    default: Console.Error.WriteLine($"unknown role '{args[0]}'"); return 2;
                }
            }
            catch (Exception e) { Console.Error.WriteLine("ERROR " + e.Message); return 1; }
        }

        private static void Report(string transport, string role, long bytes, long frames, TimeSpan el, long expected)
        {
            double s = Math.Max(el.TotalSeconds, 1e-9);
            double mbps = bytes / s / (1 << 20);
            double gbps = bytes / s / (1 << 30);
            long loss = expected > 0 ? expected - bytes : 0;
            Console.WriteLine($"RESULT transport={transport} role={role} bytes={bytes} frames={frames} secs={s:F3} " +
                $"MBps={mbps:F1} GBps={gbps:F2} fps={(frames / s):F0} lossBytes={(loss < 0 ? 0 : loss)}");
        }

        // ---- SINK: receive bytes, write to disk, measure to-disk throughput ----
        private static int Sink(string[] a)
        {
            string transport = Arg(a, "--transport", "tcp");
            int port = int.Parse(Arg(a, "--port", "9100"));
            long total = Bytes(Arg(a, "--bytes", "1G"));
            bool discard = Flag(a, "--discard");
            bool fsync = Flag(a, "--fsync");
            long fsyncEvery = Bytes(Arg(a, "--fsync-every", "0")); // periodic durability => measure SUSTAINED disk rate
            string outPath = Arg(a, "--out", Environment.GetEnvironmentVariable("HOME") + "/.tpd-sink.bin");
            int bufSize = (int)Bytes(Arg(a, "--buf", "4M"));
            string group = Arg(a, "--group", "239.7.4.20");

            FileStream fs = discard ? null : new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.None, bufSize, FileOptions.SequentialScan);
            var buf = new byte[bufSize];
            long got = 0, frames = 0, sinceSync = 0;
            var sw = new Stopwatch();
            bool started = false;

            if (transport == "tcp")
            {
                var l = new TcpListener(IPAddress.Any, port);
                l.Start();
                Console.Error.WriteLine($"[sink] tcp listening :{port} -> {(discard ? "discard" : outPath)} (want {total} bytes)");
                using var sock = l.AcceptSocket();
                sock.ReceiveBufferSize = 1 << 22;
                while (got < total)
                {
                    int n = sock.Receive(buf, 0, buf.Length, SocketFlags.None);
                    if (n <= 0) break;
                    if (!started) { sw.Start(); started = true; }
                    fs?.Write(buf, 0, n);
                    got += n; frames++; sinceSync += n;
                    if (fsyncEvery > 0 && fs != null && sinceSync >= fsyncEvery) { fs.Flush(true); sinceSync = 0; }
                }
                l.Stop();
            }
            else // udp or mcast: datagrams
            {
                using var sock = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                sock.ReceiveBufferSize = 1 << 26;
                sock.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                sock.Bind(new IPEndPoint(IPAddress.Any, port));
                if (transport == "mcast")
                    sock.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership,
                        new MulticastOption(IPAddress.Parse(group), IPAddress.Any));
                sock.ReceiveTimeout = 4000;
                Console.Error.WriteLine($"[sink] {transport} recv :{port} -> {(discard ? "discard" : outPath)} (want {total} bytes)");
                while (got < total)
                {
                    int n;
                    try { n = sock.Receive(buf, 0, buf.Length, SocketFlags.None); }
                    catch (SocketException) { break; } // idle timeout => sender done
                    if (n <= 0) break;
                    if (!started) { sw.Start(); started = true; }
                    fs?.Write(buf, 0, n);
                    got += n; frames++; sinceSync += n;
                    if (fsyncEvery > 0 && fs != null && sinceSync >= fsyncEvery) { fs.Flush(true); sinceSync = 0; }
                }
            }

            if (fs != null) { fs.Flush(true); fs.Dispose(); if (!discard) File.Delete(outPath); }
            sw.Stop();
            Report(transport, "sink", got, frames, sw.Elapsed, total);
            return 0;
        }

        // ---- SOURCE: emit bytes as fast as possible under the chosen strategy ----
        private static int Source(string[] a)
        {
            string transport = Arg(a, "--transport", "tcp");
            string host = Arg(a, "--host", "127.0.0.1");
            int port = int.Parse(Arg(a, "--port", "9100"));
            int frame = (int)Bytes(Arg(a, "--frame", "64K"));
            long total = Bytes(Arg(a, "--bytes", "1G"));
            int conns = int.Parse(Arg(a, "--conns", "1"));
            string group = Arg(a, "--group", "239.7.4.20");
            var payload = new byte[frame];
            new Random(1).NextBytes(payload);
            var sw = Stopwatch.StartNew();
            long sent = 0, frames = 0;

            if (transport == "tcp")
            {
                // persistent streaming connection(s): one connect, then stream frames back-to-back.
                long perConn = total / conns;
                Parallel.For(0, conns, _ =>
                {
                    using var sock = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                    sock.NoDelay = true; sock.SendBufferSize = 1 << 22;
                    sock.Connect(host, port);
                    long s = 0;
                    while (s < perConn) { sock.Send(payload, 0, frame, SocketFlags.None); s += frame; Interlocked.Increment(ref frames); }
                    sock.Shutdown(SocketShutdown.Both);
                    Interlocked.Add(ref sent, s);
                });
            }
            else // udp / mcast: fire datagrams (frame <= 65507)
            {
                int dg = Math.Min(frame, 65507);
                using var sock = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                sock.SendBufferSize = 1 << 26;
                if (transport == "mcast") sock.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 1);
                var ep = new IPEndPoint(IPAddress.Parse(transport == "mcast" ? group : host), port);
                while (sent < total) { sock.SendTo(payload, 0, dg, SocketFlags.None, ep); sent += dg; frames++; }
            }

            sw.Stop();
            Report(transport, "source", sent, frames, sw.Elapsed, 0);
            return 0;
        }
    }
}
