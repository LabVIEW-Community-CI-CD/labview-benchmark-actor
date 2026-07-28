using System.Globalization;

namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>Tiny <c>--key value</c> / <c>--flag</c> parser (same shape as the CLI and runner).</summary>
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
            string value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)
                ? args[++i]
                : "true";
            m._map[key] = value;
        }

        return m;
    }

    public string? Get(string key) => _map.TryGetValue(key, out string? v) ? v : null;

    public int GetInt(string key, int fallback) =>
        _map.TryGetValue(key, out string? v)
        && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)
            ? n
            : fallback;
}
