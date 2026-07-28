using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
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
            // Honor the LOCALAPPDATA env var first (standard on Windows, and required for
            // test/store isolation + redirected profiles). GetFolderPath reads the shell
            // known-folder API and ignores the env var, so an override set by a parent
            // process (e.g. the cross-plane stress gate) would otherwise be silently lost.
            root = Environment.GetEnvironmentVariable("LOCALAPPDATA") is { Length: > 0 } local
                ? local
                : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
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

    /// <summary>Atomically replace a lease (temp file + rename) so a reader never observes an empty/torn file.</summary>
    public static void Write(ResourceLease lease)
    {
        string path = PathFor(lease.Resource);
        string tmp = path + ".tmp." + Guid.NewGuid().ToString("N");
        File.WriteAllText(tmp, JsonSerializer.Serialize(lease, Json));
        try
        {
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
            throw;
        }
    }

    /// <summary>
    /// Atomically reclaim a STALE lease by holding an EXCLUSIVE handle across read-decide-overwrite and
    /// rewriting it in place. Returns false (held) if another agent holds the handle, the file vanished, or it
    /// was refreshed and is no longer stale. The file is never moved aside or deleted, so the path is never
    /// momentarily empty for a concurrent create to slip through (the residual stale-race LINUX #15 caught).
    /// </summary>
    public static bool TryReclaimInPlace(string name, ResourceLease fresh)
    {
        string path = PathFor(name);
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            string existingText;
            using (var ms = new MemoryStream())
            {
                fs.CopyTo(ms);
                existingText = Encoding.UTF8.GetString(ms.ToArray());
            }

            ResourceLease? current = TryParse(existingText);
            if (current is not null && !IsStale(current, out _))
            {
                return false; // refreshed before we got the exclusive handle — not ours to take
            }

            byte[] outBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(fresh, Json));
            fs.Seek(0, SeekOrigin.Begin);
            fs.SetLength(0);
            fs.Write(outBytes, 0, outBytes.Length);
            fs.Flush();
            return true;
        }
        catch (IOException)
        {
            return false; // another racer holds the exclusive handle, or the file vanished
        }
    }

    private static ResourceLease? TryParse(string text)
    {
        try
        {
            return JsonSerializer.Deserialize<ResourceLease>(text, Json);
        }
        catch
        {
            return null;
        }
    }

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

        // The exclusive create failed — a lease file exists. Read it.
        string path = LeaseStore.PathFor(name);
        ResourceLease? existing = LeaseStore.Read(path);

        // A torn/empty/locked read means another agent is creating or writing its lease RIGHT NOW. Treat it as
        // held and NEVER reclaim it — reclaiming on null is what let a racer delete an in-flight winner's
        // still-empty lease and steal it, cascading to N winners (LINUX #15 concurrency-stress finding).
        if (existing is null)
        {
            return (AcquireResult.Held, null);
        }

        // A valid, live lease — held by its holder.
        if (!LeaseStore.IsStale(existing, out _))
        {
            return (AcquireResult.Held, existing);
        }

        // A valid but STALE lease (TTL expired or dead pid). Reclaim ATOMICALLY: hold an EXCLUSIVE handle on
        // the lease file across read-decide-overwrite and rewrite it in place. The file is never moved aside or
        // deleted, so the path is never momentarily empty for a concurrent create to slip through (that
        // empty-path window was the residual stale-race). Exactly one racer gets the exclusive handle; the rest
        // see IOException on their read/create and report Held.
        return LeaseStore.TryReclaimInPlace(name, lease)
            ? (AcquireResult.Stolen, null)
            : (AcquireResult.Held, LeaseStore.Read(path));
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

