using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// <c>lbabus agents</c> — emits the canonical agent base instructions that are EMBEDDED in (and therefore
/// pinned to) this <c>lbabus</c> version. Every session on the same version shares byte-identical
/// instructions, so the base is a single hardenable control surface that iterates version-over-version.
/// <list type="bullet">
///   <item><c>agents</c>               — print the canonical instructions (stamped header) to stdout.</item>
///   <item><c>agents --out &lt;path&gt;</c>  — materialize them to a known file location.</item>
///   <item><c>agents --check &lt;path&gt;</c> — compare a file's body to the embedded canonical; exit 3 on drift.</item>
/// </list>
/// </summary>
internal static class AgentsCommand
{
    private const string ResourceSuffix = ".agents.AGENTS.md";
    private const string RoleResourceInfix = "agents.roles.";

    internal static int Run(string[] argv)
    {
        var a = new ArgMap(argv);

        if (a.Get("list-roles") is not null)
        {
            IReadOnlyList<string> roles = AvailableRoles();
            if (roles.Count == 0) { Console.WriteLine($"agents: no role overlays embedded in lbabus v{Version()}"); return 0; }
            Console.WriteLine($"agents: {roles.Count} role overlay(s) embedded in lbabus v{Version()}:");
            foreach (string r in roles) { Console.WriteLine($"  {r}"); }
            return 0;
        }

        string version = Version();
        string baseBody = LoadEmbedded();

        // Optional role: --role <name> wins; else --role-from-commit derives the name from the commit
        // DESCRIPTION (the `Actor:`/`Agent:` git trailer) of the commit this actor was built from — so an
        // actor's specialized instructions are reproducible from just the commit it checked out to build.
        (string? role, string? roleSource) = ResolveRole(a);
        string? overlay = null;
        if (role is not null)
        {
            overlay = LoadRoleOverlay(role);
            if (overlay is null)
            {
                string known = AvailableRoles().Count == 0 ? "(none)" : string.Join(", ", AvailableRoles());
                Console.Error.WriteLine($"agents: unknown role '{role}'{(roleSource is null ? string.Empty : $" (from {roleSource})")} — no agents/roles/{role}.md overlay in lbabus v{version}; emitting base only. Known roles: {known}");
                role = null;
            }
        }

        string body = overlay is null ? Normalize(baseBody) : Compose(baseBody, overlay, role!);
        string sha = Sha256(Normalize(body));
        string roleTag = role is null ? string.Empty : $" role:{role}";

        if (a.Get("check") is { } checkPath && !checkPath.Equals("true", StringComparison.Ordinal))
        {
            if (!File.Exists(checkPath)) { return Fail($"agents --check: file not found: {checkPath}"); }
            string targetBody = Normalize(StripHeader(File.ReadAllText(checkPath)));
            if (Sha256(targetBody) == sha)
            {
                Console.WriteLine($"agents: {checkPath} matches embedded canonical (v{version}{roleTag} sha256:{sha[..12]})");
                return 0;
            }

            Console.Error.WriteLine($"agents: DRIFT — {checkPath} does not match the embedded canonical (v{version}{roleTag}). Regenerate with: lbabus agents{(role is null ? string.Empty : $" --role {role}")} --out {checkPath}");
            return 3;
        }

        string stamped = Header(version, sha, role) + body;
        if (a.Get("out") is { } outPath && !outPath.Equals("true", StringComparison.Ordinal))
        {
            File.WriteAllText(outPath, stamped, new UTF8Encoding(false));
            Console.WriteLine($"agents: wrote {outPath} (v{version}{roleTag} sha256:{sha[..12]}, {body.Length} bytes)");
            return 0;
        }

        Console.Out.Write(stamped);
        if (!stamped.EndsWith('\n')) { Console.Out.Write('\n'); }
        return 0;
    }

    private static string Header(string version, string sha, string? role) =>
        $"<!-- lbabus-agents v{version}{(role is null ? string.Empty : $" role:{role}")} sha256:{sha} — canonical base instructions" +
        (role is null ? string.Empty : $" + '{role}' role overlay") + " embedded in lbabus. " +
        "Do not hand-edit; iterate tools/collab-cli/agents/ and re-release. Verify: lbabus agents" +
        (role is null ? string.Empty : $" --role {role}") + " --check <path> -->\n\n";

    /// <summary>Base instructions followed by the role overlay, with a machine-readable role marker between them.</summary>
    private static string Compose(string baseBody, string overlayBody, string role) =>
        Normalize(baseBody) + "\n<!-- lbabus-agents-role: " + role + " -->\n\n" + Normalize(overlayBody);

    /// <summary>Resolve an optional role from <c>--role &lt;name&gt;</c> or <c>--role-from-commit [ref]</c> (+ <c>--repo</c>).</summary>
    private static (string? Role, string? Source) ResolveRole(ArgMap a)
    {
        if (a.Get("role") is { } explicitRole && !explicitRole.Equals("true", StringComparison.Ordinal))
        {
            return (SanitizeRole(explicitRole), "--role");
        }

        if (a.Get("role-from-commit") is { } fromCommit)
        {
            string reference = fromCommit.Equals("true", StringComparison.Ordinal) ? "HEAD" : fromCommit;
            string repo = a.Get("repo") ?? ".";
            string? message = ReadCommitMessage(repo, reference);
            if (message is null)
            {
                Console.Error.WriteLine($"agents: --role-from-commit: could not read commit '{reference}' in '{repo}' (is this a git checkout with git on PATH?); emitting base only");
                return (null, null);
            }

            if (ParseActorTrailer(message) is not { } trailer)
            {
                Console.Error.WriteLine($"agents: --role-from-commit: commit '{reference}' has no `Actor: <role>` trailer; emitting base only");
                return (null, null);
            }

            return (SanitizeRole(trailer), $"commit {reference}");
        }

        return (null, null);
    }

    /// <summary>Read a commit's full description (<c>git -C repo log -1 --format=%B ref</c>), or null on any failure.</summary>
    private static string? ReadCommitMessage(string repo, string reference)
    {
        try
        {
            var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            psi.ArgumentList.Add("-C"); psi.ArgumentList.Add(repo);
            psi.ArgumentList.Add("log"); psi.ArgumentList.Add("-1"); psi.ArgumentList.Add("--format=%B"); psi.ArgumentList.Add(reference);
            using Process? p = Process.Start(psi);
            if (p is null) { return null; }
            string outText = p.StandardOutput.ReadToEnd();
            _ = p.StandardError.ReadToEnd();
            p.WaitForExit(10_000);
            return p.ExitCode == 0 ? outText : null;
        }
        catch { return null; }
    }

    /// <summary>Last <c>Actor:</c>/<c>Agent:</c> git-trailer value in a commit message (trailers sit at the end), or null.</summary>
    private static string? ParseActorTrailer(string message)
    {
        string? found = null;
        foreach (string raw in message.Replace("\r", string.Empty).Split('\n'))
        {
            string line = raw.Trim();
            int colon = line.IndexOf(':');
            if (colon <= 0) { continue; }
            string key = line[..colon].Trim();
            if (key.Equals("Actor", StringComparison.OrdinalIgnoreCase) || key.Equals("Agent", StringComparison.OrdinalIgnoreCase))
            {
                string val = line[(colon + 1)..].Trim();
                if (val.Length > 0) { found = val; }
            }
        }

        return found;
    }

    /// <summary>Lowercase to a URL/dns-safe role slug (<c>[a-z0-9-]</c>), or null if nothing usable remains.</summary>
    private static string? SanitizeRole(string raw)
    {
        var sb = new StringBuilder();
        foreach (char c in raw.Trim().ToLowerInvariant())
        {
            if (c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-') { sb.Append(c); }
            else if (c is ' ' or '_' or '/' or '.') { sb.Append('-'); }
        }

        string s = sb.ToString().Trim('-');
        return s.Length == 0 ? null : s;
    }

    private static string? LoadRoleOverlay(string role)
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
        string suffix = $"{RoleResourceInfix}{role}.md";
        string? name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));
        if (name is null) { return null; }
        using Stream s = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(s, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static IReadOnlyList<string> AvailableRoles()
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
        var roles = new List<string>();
        foreach (string n in asm.GetManifestResourceNames())
        {
            int idx = n.IndexOf(RoleResourceInfix, StringComparison.Ordinal);
            if (idx < 0 || !n.EndsWith(".md", StringComparison.Ordinal)) { continue; }
            string roleName = n[(idx + RoleResourceInfix.Length)..^".md".Length];
            if (roleName.Length > 0 && !roleName.Contains('.')) { roles.Add(roleName); }
        }

        roles.Sort(StringComparer.Ordinal);
        return roles;
    }

    /// <summary>Drops a leading <c>&lt;!-- lbabus-agents ... --&gt;</c> stamp (and following blank lines) if present.</summary>
    private static string StripHeader(string text)
    {
        if (text.StartsWith("<!-- lbabus-agents ", StringComparison.Ordinal))
        {
            int end = text.IndexOf("-->", StringComparison.Ordinal);
            if (end >= 0) { text = text[(end + 3)..].TrimStart('\r', '\n'); }
        }

        return text;
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n").TrimEnd() + "\n";

    private static string LoadEmbedded()
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
        string? name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(ResourceSuffix, StringComparison.Ordinal));
        if (name is null) { throw new InvalidOperationException("embedded AGENTS.md resource not found"); }
        using Stream s = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(s, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string Version()
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
        string? info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrEmpty(info)) { int plus = info.IndexOf('+'); return plus > 0 ? info[..plus] : info; }
        return asm.GetName().Version?.ToString() ?? "0.0.0";
    }

    private static string Sha256(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    private static int Fail(string message)
    {
        Console.Error.WriteLine($"lbabus: {message}");
        return 2;
    }
}
