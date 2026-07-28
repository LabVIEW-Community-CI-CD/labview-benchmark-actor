namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Message priority tier for the coordination bus (LBA-REQ-013). Four tiers,
/// most-urgent first: <c>P0</c> (urgent) &gt; <c>P1</c> (high) &gt; <c>P2</c>
/// (normal, the default) &gt; <c>P3</c> (routine). A lower rank number is more
/// urgent. Priority is a recipient-side triage hint carried in the envelope
/// (<c>prio</c>): <c>post --priority</c> sets it and <c>poll</c>/<c>wait
/// --min-priority</c> filter on it. It is additive and backward-read-compatible
/// — a message with no <c>prio</c> field reads as <see cref="Default"/>.
/// </summary>
public static class Priority
{
    /// <summary>The tier assumed when a message carries no explicit <c>prio</c>.</summary>
    public const string Default = "P2";

    private static readonly IReadOnlyDictionary<string, int> Ranks =
        new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["P0"] = 0,
            ["P1"] = 1,
            ["P2"] = 2,
            ["P3"] = 3,
        };

    /// <summary>All valid tier labels, most-urgent first, for help/usage text.</summary>
    public static IReadOnlyList<string> Tiers { get; } = new[] { "P0", "P1", "P2", "P3" };

    /// <summary>
    /// Canonical upper-case tier string, or <c>null</c> when the input is not a
    /// valid tier. Whitespace/empty input is not valid (callers treat that as
    /// "flag not supplied").
    /// </summary>
    public static string? TryNormalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string v = value.Trim().ToUpperInvariant();
        return Ranks.ContainsKey(v) ? v : null;
    }

    /// <summary>
    /// Rank of a tier (0 = most urgent). An unknown or absent tier resolves to
    /// the <see cref="Default"/> rank, so an un-prioritized message sorts as P2.
    /// </summary>
    public static int RankOf(string? value)
    {
        string normalized = TryNormalize(value) ?? Default;
        return Ranks[normalized];
    }

    /// <summary>
    /// True when <paramref name="messageTier"/> is at least as urgent as
    /// <paramref name="threshold"/> (i.e. its rank is not weaker). Used by the
    /// <c>--min-priority</c> triage filter.
    /// </summary>
    public static bool MeetsThreshold(string? messageTier, string threshold) =>
        RankOf(messageTier) <= RankOf(threshold);
}
