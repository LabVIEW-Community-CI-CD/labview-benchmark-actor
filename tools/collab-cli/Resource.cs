using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// A durable, cross-process lease on a named resource. Written as one JSON file per resource via an
/// exclusive-create (atomic) primitive, so separate agent processes on one machine serialize access to
/// scarce hardware/system resources (a LabVIEW runtime, Docker, a device) — and, applied to the
/// <c>coordination-bus</c> resource, it is the cross-process mutex that gates bus publishes.
/// </summary>
public sealed record ResourceLease(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("holderAgent")] string HolderAgent,
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("host")] string Host,
    [property: JsonPropertyName("acquiredAt")] DateTimeOffset AcquiredAt,
    [property: JsonPropertyName("expiresAt")] DateTimeOffset ExpiresAt);

/// <summary>Outcome of an acquire attempt.</summary>
internal enum AcquireResult { Acquired, Held, Stolen }

/// <summary>
/// Cross-process lease store: one file per resource in a per-OS state dir. Acquire = exclusive-create
/// (<see cref="FileMode.CreateNew"/>) which throws atomically if the lease is held. A held lease is
/// reclaimable when it is past TTL, or when its holder pid is dead on THIS host (liveness), so a crashed
/// agent never deadlocks the resource.
/// </summary>
internal static class LeaseStore
{
    public const string Schema = "lbabus-lease@v1";

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    public static string Dir()
    {
        string root;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            root = Path.Combine(Home(), "Library", "Application Support");
        }
        else
        {
            root = Environment.GetEnvironmentVariable("XDG_STATE_HOME") is { Length: > 0 } xdg
                ? xdg
                : Path.Combine(Home(), ".local", "state");
        }

        string dir = Path.Combine(root, "lbabus", "leases");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string Home() =>
        Environment.GetEnvironmentVariable("HOME")
        ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>Lease file path for a resource name (":" and other unsafe chars sanitized in the filename only).</summary>
    public static string PathFor(string resource)
    {
        string safe = string.Concat(resource.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_'));
        return Path.Combine(Dir(), safe + ".lease.json");
    }

    public static ResourceLease? Read(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<ResourceLease>(File.ReadAllText(path), Json);
        }
        catch
        {
            return null;
        }
    }

    public static IReadOnlyList<ResourceLease> ReadAll()
    {
        var list = new List<ResourceLease>();
        foreach (string f in Directory.GetFiles(Dir(), "*.lease.json"))
        {
            if (Read(f) is { } lease)
            {
                list.Add(lease);
            }
        }

        return list;
    }

    /// <summary>True when a lease is reclaimable: past TTL, or its holder pid is dead on this host.</summary>
    public static bool IsStale(ResourceLease lease, out string reason)
    {
        if (DateTimeOffset.UtcNow >= lease.ExpiresAt)
        {
            reason = $"expired at {lease.ExpiresAt:u}";
            return true;
        }

        if (lease.Pid > 0 && string.Equals(lease.Host, Environment.MachineName, StringComparison.OrdinalIgnoreCase) && !PidAlive(lease.Pid))
        {
            reason = $"holder pid {lease.Pid} is dead on {lease.Host}";
            return true;
        }

        reason = string.Empty;
        return false;
    }

    private static bool PidAlive(int pid)
    {
        if (pid <= 0)
        {
            return false;
        }

        try
        {
            using Process _ = Process.GetProcessById(pid);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch
        {
            // Can't tell (permissions) — treat as alive to avoid stealing a live lease.
            return true;
        }
    }

    /// <summary>Atomically try to write a fresh lease. Returns true iff the exclusive-create succeeded.</summary>
    public static bool TryCreate(ResourceLease lease)
    {
        string path = PathFor(lease.Resource);
        try
        {
            using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var w = new StreamWriter(fs);
            w.Write(JsonSerializer.Serialize(lease, Json));
            return true;
        }
        catch (IOException)
        {
            // File already exists — lease is held.
            return false;
        }
    }

    public static void Write(ResourceLease lease)
        => File.WriteAllText(PathFor(lease.Resource), JsonSerializer.Serialize(lease, Json));

    public static void Delete(string resource)
    {
        try
        {
            File.Delete(PathFor(resource));
        }
        catch
        {
            // already gone
        }
    }

    public static string ToJson(object value) => JsonSerializer.Serialize(value, Json);
}

/// <summary>
/// <c>lbabus resource</c> subcommands: list / status / acquire / release / renew. Resources are
/// capability-derived (plus the coordination-bus mutex + any ad-hoc name). Cooperative + advisory:
/// agents that go through <c>lbabus resource</c> serialize; the store never blocks the OS.
/// </summary>
internal static class ResourceCommands
{
    public static int Run(string[] tail)
    {
        if (tail.Length == 0)
        {
            Console.Error.WriteLine("lbabus resource <list|status|acquire|release|renew> [name] [--agent <id>] [--ttl <sec>] [--wait [--timeout <sec>]]");
            return 1;
        }

        string sub = tail[0].ToLowerInvariant();
        var a = new ArgMap(tail.Skip(1));
        string? name = tail.Skip(1).FirstOrDefault(t => !t.StartsWith("--", StringComparison.Ordinal));
        string agent = a.Get("agent") ?? Config.FromEnvironment().Agent;

        return sub switch
        {
            "list" => List(),
            "status" => Status(),
            "acquire" => Acquire(name, agent, a),
            "release" => Release(name, agent),
            "renew" => Renew(name, agent, a),
            _ => Bad($"unknown resource subcommand '{sub}' (list|status|acquire|release|renew)"),
        };
    }

    private static int List()
    {
        var leases = LeaseStore.ReadAll().ToDictionary(l => l.Resource, StringComparer.OrdinalIgnoreCase);
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase) { "coordination-bus" };
        foreach (HostCapability c in Capabilities.Detect())
        {
            if (c.Available)
            {
                names.Add(c.Name);
            }
        }

        foreach (string k in leases.Keys)
        {
            names.Add(k);
        }

        Console.WriteLine($"# resources ({LeaseStore.Dir()})");
        foreach (string n in names)
        {
            if (leases.TryGetValue(n, out ResourceLease? lease) && !LeaseStore.IsStale(lease, out _))
            {
                Console.WriteLine($"  [held] {n,-20} by {lease.HolderAgent} (pid {lease.Pid}@{lease.Host}) until {lease.ExpiresAt:u}");
            }
            else
            {
                Console.WriteLine($"  [free] {n,-20}{(leases.ContainsKey(n) ? "  (stale lease reclaimable)" : string.Empty)}");
            }
        }

        return 0;
    }

    private static int Status()
    {
        Console.WriteLine(LeaseStore.ToJson(LeaseStore.ReadAll()));
        return 0;
    }

    private static int Acquire(string? name, string agent, ArgMap a)
    {
        if (name is null)
        {
            return Bad("resource acquire requires a <name>.");
        }

        int ttl = Math.Max(a.GetInt("ttl", 300), 1);
        int pid = a.GetInt("pid", 0);
        bool wait = a.Get("wait") is not null;
        int timeoutSec = a.GetInt("timeout", 60);
        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSec);
        var rng = new Random();

        while (true)
        {
            (AcquireResult outcome, ResourceLease? blocker) = TryAcquireOnce(name, agent, ttl, pid);
            if (outcome is AcquireResult.Acquired or AcquireResult.Stolen)
            {
                DateTimeOffset expires = DateTimeOffset.UtcNow.AddSeconds(ttl);
                Console.WriteLine($"acquired {name} for {agent} (ttl {ttl}s, expires {expires:u}){(outcome == AcquireResult.Stolen ? " [stole stale lease]" : string.Empty)}");
                return 0;
            }

            if (!wait)
            {
                Console.Error.WriteLine($"lbabus: {name} is held by {blocker?.HolderAgent ?? "?"} until {blocker?.ExpiresAt:u} — not acquired.");
                return 5;
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                Console.Error.WriteLine($"lbabus: timed out after {timeoutSec}s waiting for {name}.");
                return 2;
            }

            Thread.Sleep(200 + rng.Next(0, 300));
        }
    }

    private static (AcquireResult, ResourceLease?) TryAcquireOnce(string name, string agent, int ttl, int pid)
    {
        var lease = new ResourceLease(LeaseStore.Schema, name, agent, pid, Environment.MachineName,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddSeconds(ttl));

        if (LeaseStore.TryCreate(lease))
        {
            return (AcquireResult.Acquired, null);
        }

        ResourceLease? existing = LeaseStore.Read(LeaseStore.PathFor(name));
        if (existing is null || LeaseStore.IsStale(existing, out _))
        {
            // Reclaim: delete the stale/torn lease and retry the atomic create. If another agent wins the
            // race, its exclusive-create beats ours and we report Held.
            LeaseStore.Delete(name);
            return LeaseStore.TryCreate(lease) ? (AcquireResult.Stolen, null) : (AcquireResult.Held, LeaseStore.Read(LeaseStore.PathFor(name)));
        }

        return (AcquireResult.Held, existing);
    }

    private static int Release(string? name, string agent)
    {
        if (name is null)
        {
            return Bad("resource release requires a <name>.");
        }

        ResourceLease? existing = LeaseStore.Read(LeaseStore.PathFor(name));
        if (existing is null)
        {
            Console.WriteLine($"{name} already free.");
            return 0;
        }

        if (!string.Equals(existing.HolderAgent, agent, StringComparison.Ordinal))
        {
            Console.Error.WriteLine($"lbabus: {name} is held by {existing.HolderAgent}, not {agent} — refusing to release.");
            return 6;
        }

        LeaseStore.Delete(name);
        Console.WriteLine($"released {name}.");
        return 0;
    }

    private static int Renew(string? name, string agent, ArgMap a)
    {
        if (name is null)
        {
            return Bad("resource renew requires a <name>.");
        }

        ResourceLease? existing = LeaseStore.Read(LeaseStore.PathFor(name));
        if (existing is null)
        {
            Console.Error.WriteLine($"lbabus: {name} is not held — nothing to renew.");
            return 5;
        }

        if (!string.Equals(existing.HolderAgent, agent, StringComparison.Ordinal))
        {
            Console.Error.WriteLine($"lbabus: {name} is held by {existing.HolderAgent}, not {agent} — refusing to renew.");
            return 6;
        }

        int ttl = Math.Max(a.GetInt("ttl", 300), 1);
        LeaseStore.Write(existing with { ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(ttl) });
        Console.WriteLine($"renewed {name} for {agent} (ttl {ttl}s).");
        return 0;
    }

    private static int Bad(string message)
    {
        Console.Error.WriteLine("lbabus: " + message);
        return 1;
    }
}

