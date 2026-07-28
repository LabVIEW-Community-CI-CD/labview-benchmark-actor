using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// <c>lbabus docs</c> — emits the canonical documentation package that is EMBEDDED in (and therefore
/// pinned to) this <c>lbabus</c> version. It is the documentation companion to <c>lbabus agents</c>:
/// every session on the same version shares a byte-identical documentation guide, so the docs posture
/// is a single hardenable control surface that iterates version-over-version.
/// <list type="bullet">
///   <item><c>docs</c>               — print the canonical documentation package (stamped header) to stdout.</item>
///   <item><c>docs --out &lt;path&gt;</c>  — materialize it to a known file location.</item>
///   <item><c>docs --check &lt;path&gt;</c> — compare a file's body to the embedded canonical; exit 3 on drift.</item>
/// </list>
/// </summary>
internal static class DocsCommand
{
    private const string ResourceSuffix = ".docs.DOCS.md";

    internal static int Run(string[] argv)
    {
        var a = new ArgMap(argv);
        string body = LoadEmbedded();
        string version = Version();
        string sha = Sha256(Normalize(body));

        if (a.Get("check") is { } checkPath)
        {
            if (!File.Exists(checkPath)) { return Fail($"docs --check: file not found: {checkPath}"); }
            string targetBody = Normalize(StripHeader(File.ReadAllText(checkPath)));
            if (Sha256(targetBody) == sha)
            {
                Console.WriteLine($"docs: {checkPath} matches embedded canonical (v{version} sha256:{sha[..12]})");
                return 0;
            }

            Console.Error.WriteLine($"docs: DRIFT — {checkPath} does not match the embedded canonical (v{version}). Regenerate with: lbabus docs --out {checkPath}");
            return 3;
        }

        string stamped = Header(version, sha) + body;
        if (a.Get("out") is { } outPath)
        {
            File.WriteAllText(outPath, stamped, new UTF8Encoding(false));
            Console.WriteLine($"docs: wrote {outPath} (v{version} sha256:{sha[..12]}, {body.Length} bytes)");
            return 0;
        }

        Console.Out.Write(stamped);
        if (!stamped.EndsWith('\n')) { Console.Out.Write('\n'); }
        return 0;
    }

    private static string Header(string version, string sha) =>
        $"<!-- lbabus-docs v{version} sha256:{sha} — canonical documentation package embedded in lbabus. " +
        "Do not hand-edit; iterate tools/collab-cli/docs/DOCS.md and re-release. Verify: lbabus docs --check <path> -->\n\n";

    /// <summary>Drops a leading <c>&lt;!-- lbabus-docs ... --&gt;</c> stamp (and following blank lines) if present.</summary>
    private static string StripHeader(string text)
    {
        if (text.StartsWith("<!-- lbabus-docs ", StringComparison.Ordinal))
        {
            int end = text.IndexOf("-->", StringComparison.Ordinal);
            if (end >= 0) { text = text[(end + 3)..].TrimStart('\r', '\n'); }
        }

        return text;
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n").TrimEnd() + "\n";

    private static string LoadEmbedded()
    {
        Assembly asm = typeof(DocsCommand).Assembly;
        string? name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(ResourceSuffix, StringComparison.Ordinal));
        if (name is null) { throw new InvalidOperationException("embedded DOCS.md resource not found"); }
        using Stream s = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(s, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string Version()
    {
        Assembly asm = typeof(DocsCommand).Assembly;
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
