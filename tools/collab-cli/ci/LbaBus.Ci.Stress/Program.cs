using System.Diagnostics;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus.Ci.Stress;

/// <summary>
/// Cross-plane concurrency stress gate for <c>lbabus resource</c> (LINUX #15 slice). Spawns many real
/// concurrent <c>lbabus resource</c> processes and asserts the cross-process lease invariants. This is
/// the regression gate for the mutual-exclusion break the LINUX stress corpus found in PR #18 — it runs
/// on Windows and Linux, and reliably surfaces a race a low-round manual check passes by luck.
///
/// Usage: lbabus-stress --lbabus &lt;path to lbabus.dll or native exe&gt; [--agents 16] [--rounds 30]
/// Exit 0 iff every invariant holds; 1 on any violation.
/// </summary>
internal static class Program
{
    private const string Schema = "lbabus-lease@v1";

    private static string _lbabus = "";
    private static string _leasesDir = "";
    private static int _agents = 16;
    private static int _rounds = 30;
    private static int _fail;

    private static int Main(string[] argv)
    {
        var a = ArgMap.Parse(argv);
        _lbabus = a.Get("lbabus") ?? "";
        _agents = a.GetInt("agents", 16);
        _rounds = a.GetInt("rounds", 30);
        if (_lbabus.Length == 0)
        {
            Console.Error.WriteLine("lbabus-stress: --lbabus <path to lbabus.dll or native exe> is required.");
            return 2;
        }

        _lbabus = Path.GetFullPath(_lbabus);

        // Isolate the lease store in a scratch per-OS state dir, matching how lbabus resolves it
        // (Windows LOCALAPPDATA / Linux XDG_STATE_HOME) so we never touch the real user store.
        string scratch = Path.Combine(Path.GetTempPath(), "lbabus-stress-" + Guid.NewGuid().ToString("N"));
        _leasesDir = Path.Combine(scratch, "lbabus", "leases");
        Directory.CreateDirectory(_leasesDir);

        Console.WriteLine($"lbabus-stress: {_agents} agents x {_rounds} rounds; store {_leasesDir}");
        Console.WriteLine($"lbabus-stress: lbabus {_lbabus} on {(OperatingSystem.IsWindows() ? "windows" : "unix")}");
        Console.WriteLine();

        try
        {
            MutexFree();
            MutexStale();
            TtlSteal();
            PidSteal();
            Idempotent();
            WaitThenAcquire();
        }
        finally
        {
            try { Directory.Delete(scratch, recursive: true); } catch { /* best effort */ }
        }

        Console.WriteLine();
        if (_fail == 0)
        {
            Console.WriteLine("lbabus-stress: ALL PASS");
            return 0;
        }

        Console.Error.WriteLine("lbabus-stress: FAILURES ABOVE");
        return 1;
    }

    // ---- 1. mutual exclusion on a FREE resource: exactly one of N concurrent acquires wins ----------
    private static void MutexFree()
    {
        int bad = 0;
        for (int r = 1; r <= _rounds; r++)
        {
            string res = $"mxfree-{r}";
            DeleteLease(res);
            int[] codes = SpawnConcurrentAcquire(res, _agents);
            int winners = codes.Count(c => c == 0);
            int held = codes.Count(c => c == 5);
            if (winners != 1 || held != _agents - 1)
            {
                Console.WriteLine($"    round {r}: winners={winners} held={held} (want 1/{_agents - 1})");
                bad++;
            }
        }

        Report(bad, "mutex-free", $"{_rounds} rounds x {_agents} agents: always exactly 1 winner",
            "mutual-exclusion VIOLATED on a free resource");
    }

    // ---- 2. mutual exclusion racing to steal an EXPIRED lease ---------------------------------------
    private static void MutexStale()
    {
        int bad = 0;
        for (int r = 1; r <= _rounds; r++)
        {
            string res = $"mxstale-{r}";
            SeedLease(res, "GHOST", pid: 0, host: "x", expiresIso: "2000-01-01T00:00:00Z");
            int[] codes = SpawnConcurrentAcquire(res, _agents);
            int winners = codes.Count(c => c == 0);
            if (winners != 1)
            {
                Console.WriteLine($"    round {r}: winners={winners} (want 1) — concurrent stale-reclaim race");
                bad++;
            }
        }

        Report(bad, "mutex-stale", $"{_rounds} rounds x {_agents} agents: always exactly 1 steals",
            "concurrent stale-reclaim let >1 agent acquire");
    }

    // ---- 3. single steal of an expired lease --------------------------------------------------------
    private static void TtlSteal()
    {
        const string res = "ttlsteal";
        SeedLease(res, "GHOST", pid: 0, host: "x", expiresIso: "2000-01-01T00:00:00Z");
        (int rc, string outText) = RunAcquire(res, "LINUX");
        bool ok = rc == 0 && outText.Contains("stole stale lease", StringComparison.Ordinal);
        Report(ok ? 0 : 1, "ttl-steal", "expired lease reclaimed, exit 0", $"rc={rc} out={outText.Trim()}");
    }

    // ---- 4. steal a lease whose holder pid is DEAD on this host --------------------------------------
    private static void PidSteal()
    {
        const string res = "pidsteal";
        SeedLease(res, "GHOST", pid: 999999, host: Environment.MachineName, expiresIso: "2099-01-01T00:00:00Z");
        (int rc, string outText) = RunAcquire(res, "LINUX");
        bool ok = rc == 0 && outText.Contains("stole stale lease", StringComparison.Ordinal);
        Report(ok ? 0 : 1, "pid-steal", "dead-holder lease on this host reclaimed", $"rc={rc} out={outText.Trim()}");
    }

    // ---- 5. idempotent release + no deadlock --------------------------------------------------------
    private static void Idempotent()
    {
        const string res = "idem";
        DeleteLease(res);
        int a = RunAcquire(res, "LINUX").rc;
        int r1 = Run(new[] { "resource", "release", res }, "LINUX").rc;
        int r2 = Run(new[] { "resource", "release", res }, "LINUX").rc;
        int a2 = RunAcquire(res, "LINUX").rc;
        Run(new[] { "resource", "release", res }, "LINUX");
        bool ok = a == 0 && r1 == 0 && r2 == 0 && a2 == 0;
        Report(ok ? 0 : 1, "idempotent", "acquire/release/release/re-acquire = 0/0/0/0, no deadlock",
            $"a={a} r1={r1} r2={r2} a2={a2}");
    }

    // ---- 6. --wait blocks on a held lease then acquires on expiry ------------------------------------
    private static void WaitThenAcquire()
    {
        const string res = "waitq";
        DeleteLease(res);
        Run(new[] { "resource", "acquire", res, "--ttl", "2" }, "HOLDER");
        var sw = Stopwatch.StartNew();
        int rc = Run(new[] { "resource", "acquire", res, "--ttl", "5", "--wait", "--timeout", "15" }, "WAITER").rc;
        sw.Stop();
        Run(new[] { "resource", "release", res }, "WAITER");
        bool ok = rc == 0 && sw.Elapsed.TotalSeconds >= 1;
        Report(ok ? 0 : 1, "wait", $"blocked {sw.Elapsed.TotalSeconds:F0}s for expiry then acquired, exit 0",
            $"rc={rc} waited={sw.Elapsed.TotalSeconds:F0}s");
    }

    // ---- spawning ------------------------------------------------------------------------------------
    private static int[] SpawnConcurrentAcquire(string res, int n)
    {
        var procs = new Process[n];
        for (int i = 0; i < n; i++)
        {
            procs[i] = StartLbabus(new[] { "resource", "acquire", res, "--ttl", "30" }, $"A{i}");
        }

        var codes = new int[n];
        for (int i = 0; i < n; i++)
        {
            procs[i].WaitForExit();
            codes[i] = procs[i].ExitCode;
            procs[i].Dispose();
        }

        return codes;
    }

    private static Process StartLbabus(string[] args, string agent)
    {
        var psi = new ProcessStartInfo
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (_lbabus.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = "dotnet";
            psi.ArgumentList.Add(_lbabus);
        }
        else
        {
            psi.FileName = _lbabus;
        }

        foreach (string arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        // Point the child's lease store at our scratch dir + set its agent identity.
        psi.Environment[OperatingSystem.IsWindows() ? "LOCALAPPDATA" : "XDG_STATE_HOME"] =
            Directory.GetParent(Directory.GetParent(_leasesDir)!.FullName)!.FullName;
        psi.Environment["VIHS_COLLAB_AGENT"] = agent;

        return Process.Start(psi) ?? throw new InvalidOperationException("Process.Start returned null");
    }

    private static (int rc, string outText) Run(string[] args, string agent)
    {
        using Process p = StartLbabus(args, agent);
        string outText = p.StandardOutput.ReadToEnd();
        p.StandardError.ReadToEnd();
        p.WaitForExit();
        return (p.ExitCode, outText);
    }

    private static (int rc, string outText) RunAcquire(string res, string agent) =>
        Run(new[] { "resource", "acquire", res, "--ttl", "30" }, agent);

    // ---- lease store helpers (match lbabus PathFor sanitization) ------------------------------------
    private static string SafeName(string resource) =>
        string.Concat(resource.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_'));

    private static void SeedLease(string res, string holder, int pid, string host, string expiresIso)
    {
        string json = $"{{\"schema\":\"{Schema}\",\"resource\":\"{res}\",\"holderAgent\":\"{holder}\"," +
                      $"\"pid\":{pid},\"host\":\"{host}\",\"acquiredAt\":\"2020-01-01T00:00:00Z\"," +
                      $"\"expiresAt\":\"{expiresIso}\"}}";
        File.WriteAllText(Path.Combine(_leasesDir, SafeName(res) + ".lease.json"), json, new UTF8Encoding(false));
    }

    private static void DeleteLease(string res)
    {
        try { File.Delete(Path.Combine(_leasesDir, SafeName(res) + ".lease.json")); }
        catch { /* already gone */ }
    }

    private static void Report(int bad, string name, string passDetail, string failDetail)
    {
        if (bad == 0)
        {
            Console.WriteLine($"  PASS  {name}  ({passDetail})");
        }
        else
        {
            Console.WriteLine($"  FAIL  {name}  ({failDetail})");
            _fail++;
        }
    }
}

internal sealed class ArgMap
{
    private readonly Dictionary<string, string> _map = new(StringComparer.OrdinalIgnoreCase);

    public static ArgMap Parse(string[] args)
    {
        var m = new ArgMap();
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            string key = args[i][2..];
            string value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal) ? args[++i] : "true";
            m._map[key] = value;
        }

        return m;
    }

    public string? Get(string key) => _map.TryGetValue(key, out string? v) ? v : null;

    public int GetInt(string key, int fallback) =>
        _map.TryGetValue(key, out string? v) && int.TryParse(v, out int n) ? n : fallback;
}
