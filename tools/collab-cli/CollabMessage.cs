using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// A single coordination message. Wire schema <c>vihs-collab-msg@v1</c> — byte-compatible with the
/// legacy <c>prototype/collab.mjs</c> messages so both tools can read each other during migration.
/// The rendered comment carries BOTH human-readable prose AND a fenced JSON block; agents parse the
/// JSON, humans skim the prose.
/// </summary>
public sealed class CollabMessage
{
    public const string Schema = "vihs-collab-msg@v1";

    [JsonPropertyName("schema")] public string SchemaId { get; set; } = Schema;
    [JsonPropertyName("v")] public int Version { get; set; } = 1;
    [JsonPropertyName("agent")] public string Agent { get; set; } = "";

    /// <summary>Sender's LOCAL wall clock at compose time — ADVISORY ONLY. It reflects the sender machine's
    /// clock, which can drift from the other plane's clock, so it MUST NOT be used for cross-actor timing or
    /// ordering; use the server <see cref="CreatedAt"/> instead. Retained for wire-compat + as a skew probe.</summary>
    [JsonPropertyName("ts")] public string Ts { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "NOTE";
    [JsonPropertyName("task")] public string? Task { get; set; }
    [JsonPropertyName("msg")] public string? Msg { get; set; }
    [JsonPropertyName("ref")] public string? Ref { get; set; }
    [JsonPropertyName("next")] public string? Next { get; set; }
    [JsonPropertyName("to")] public string? To { get; set; }

    /// <summary>Priority tier (LBA-REQ-013): P0/P1/P2/P3, absent == P2. See <see cref="Priority"/>.</summary>
    [JsonPropertyName("prio")] public string? Prio { get; set; }

    /// <summary>Sender's fine-grained agent id (LBA-REQ-013); defaults to the plane label, so a
    /// message with no <c>agentId</c> is addressed by plane. Enables multiple agents per plane.</summary>
    [JsonPropertyName("agentId")] public string? AgentId { get; set; }

    /// <summary>Server-side comment creation time (populated when read back from a discussion). This is the
    /// AUTHORITATIVE clock for all cross-actor timing/ordering — both planes read the same GitHub server time,
    /// so it is immune to either actor's local clock drift. Prefer this over <see cref="Ts"/> everywhere.</summary>
    [JsonIgnore] public DateTimeOffset? CreatedAt { get; set; }

    /// <summary>The GitHub comment node id (populated when read back from a discussion). A STABLE identity for
    /// cursoring, immune to GitHub's second-precision createdAt -- `wait` uses it to avoid dropping a message
    /// that shares a whole second with the baseline (issue #100).</summary>
    [JsonIgnore] public string? CommentId { get; set; }

    /// <summary>The sender-embedded <see cref="Ts"/> parsed to a UTC instant, or null if unparseable.</summary>
    [JsonIgnore]
    public DateTimeOffset? SenderTs => DateTimeOffset.TryParse(
        Ts, CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset t) ? t : null;

    /// <summary>
    /// Sender clock skew = (sender-embedded ts) - (authoritative server createdAt). Positive => the sender's
    /// local clock is AHEAD of the server (it stamped the message in the "future"); a value more negative than
    /// normal post latency => behind. Null when either time is missing. This is the root of the "peer looks
    /// like it answered much earlier/later than reality" bus flaw: never compare a peer's ts against your own
    /// clock — compare server createdAt to server createdAt.
    /// </summary>
    [JsonIgnore]
    public TimeSpan? SenderClockSkew => (CreatedAt is { } c && SenderTs is { } s) ? s - c : null;

    /// <summary>Skew beyond this (either direction) is real clock drift, not normal post latency.</summary>
    public static readonly TimeSpan SkewThreshold = TimeSpan.FromSeconds(90);

    /// <summary>A concise clock-skew note when the sender's clock diverges from the server beyond
    /// <see cref="SkewThreshold"/>, else null. The authoritative time is always the server createdAt.</summary>
    [JsonIgnore]
    public string? ClockSkewNote
    {
        get
        {
            if (SenderClockSkew is not { } skew || skew.Duration() <= SkewThreshold)
            {
                return null;
            }

            string dir = skew > TimeSpan.Zero ? "ahead of" : "behind";
            return $"[clock-skew: {Agent} sender clock ~{FormatSpan(skew.Duration())} {dir} server; authoritative time is the server createdAt shown]";
        }
    }

    /// <summary>Compact, culture-invariant duration like <c>5h12m</c> / <c>3m40s</c> / <c>12s</c>.</summary>
    internal static string FormatSpan(TimeSpan d)
    {
        if (d.TotalDays >= 1)
        {
            return $"{(int)d.TotalDays}d{d.Hours}h";
        }

        if (d.TotalHours >= 1)
        {
            return $"{(int)d.TotalHours}h{d.Minutes}m";
        }

        if (d.TotalMinutes >= 1)
        {
            return $"{d.Minutes}m{d.Seconds}s";
        }

        return $"{d.Seconds}s";
    }

    public static readonly IReadOnlySet<string> Types = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "CLAIM", "ACK", "PROGRESS", "DONE", "BLOCKED", "HANDOFF", "QUESTION", "ANSWER",
        "NOTE", "READY", "AUTHORIZE", "REFINE", "PROPOSE", "ALIGN", "SPAWNED", "RESOLVED",
    };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Render the Markdown comment body (prose header + optional fields + fenced JSON).</summary>
    public string ToBody()
    {
        var sb = new StringBuilder();
        sb.Append("### [").Append(Agent).Append("] ").Append(Type);
        if (!string.IsNullOrEmpty(Task))
        {
            sb.Append(" · task: ").Append(Task);
        }

        sb.Append(" · ").Append(Ts).Append('\n').Append('\n');

        if (!string.IsNullOrEmpty(Msg))
        {
            sb.Append(Msg).Append('\n').Append('\n');
        }

        if (!string.IsNullOrEmpty(Ref))
        {
            sb.Append("- ref: `").Append(Ref).Append("`\n");
        }

        if (!string.IsNullOrEmpty(Next))
        {
            sb.Append("- next: ").Append(Next).Append('\n');
        }

        if (!string.IsNullOrEmpty(To))
        {
            sb.Append("- to: ").Append(To).Append('\n');
        }

        if (!string.IsNullOrEmpty(Prio))
        {
            sb.Append("- prio: ").Append(Prio).Append('\n');
        }

        if (!string.IsNullOrEmpty(AgentId) && !string.Equals(AgentId, Agent, StringComparison.OrdinalIgnoreCase))
        {
            sb.Append("- agentId: ").Append(AgentId).Append('\n');
        }

        sb.Append("\n```json\n").Append(JsonSerializer.Serialize(this, JsonOptions)).Append("\n```\n");
        return sb.ToString();
    }

    // WIRE-COMPAT GUARDRAIL (verified on the Windows plane, bus finding 17812593). This extractor
    // matches a FLAT JSON object only: [^{}]* cannot span a nested brace, and the schema literal is
    // hard-coded to @v1 and re-checked Ordinally in TryParse. Two hard constraints follow for every
    // additive envelope field, so an already-deployed older reader parses-and-ignores unknown fields
    // instead of silently dropping the WHOLE message:
    //   (1) additive fields MUST stay FLAT SCALARS (string/number/bool) - never a nested object or an
    //       array of objects; a nested {} makes this regex fail to match and the message vanishes.
    //   (2) keep schema == vihs-collab-msg@v1 - do NOT bump to @v2 for an additive change.
    // The ci fixture-priority cases lock this in: flat prio/agentId parse, while a nested-priority
    // object and a schema@v2 message each return null (dropped). Never relax (1)/(2) without a
    // coordinated cross-plane schema migration.
    private static readonly Regex JsonBlock = new(
        "\\{[^{}]*\"schema\"\\s*:\\s*\"vihs-collab-msg@v1\"[^{}]*\\}",
        RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// Parse a message from a raw comment body. Returns null when the body has no
    /// <c>vihs-collab-msg@v1</c> JSON block (e.g. a human comment).
    /// </summary>
    public static CollabMessage? TryParse(string rawBody, DateTimeOffset? createdAt = null, string? commentId = null)
    {
        if (string.IsNullOrWhiteSpace(rawBody))
        {
            return null;
        }

        Match match = JsonBlock.Match(rawBody);
        if (!match.Success)
        {
            return null;
        }

        try
        {
            CollabMessage? msg = JsonSerializer.Deserialize<CollabMessage>(match.Value, JsonOptions);
            if (msg is null || !string.Equals(msg.SchemaId, Schema, StringComparison.Ordinal))
            {
                return null;
            }

            msg.CreatedAt = createdAt;
            msg.CommentId = commentId;
            return msg;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>One-line human/agent-readable rendering for <c>poll</c>/<c>wait</c> output.</summary>
    public string ToLine()
    {
        string ts = CreatedAt?.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") ?? Ts;
        string task = string.IsNullOrEmpty(Task) ? "" : " " + Task;
        string prio = !string.IsNullOrEmpty(Prio) && !string.Equals(Prio, Priority.Default, StringComparison.OrdinalIgnoreCase) ? " [" + Prio.ToUpperInvariant() + "]" : "";
        string body = (Msg ?? "").Replace("\r", " ").Replace("\n", " ");
        if (body.Length > 240)
        {
            body = body[..240] + "…";
        }

        string skewNote = ClockSkewNote is { } n ? " " + n : "";
        return $"[{ts}] {Agent} {Type}{task}{prio} — {body}{skewNote}".TrimEnd();
    }

    /// <summary>Complete, untruncated rendering for <c>poll --full</c> — never drops the message tail.</summary>
    public string ToFull()
    {
        string ts = CreatedAt?.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") ?? Ts;
        string task = string.IsNullOrEmpty(Task) ? "" : "  task: " + Task;
        var sb = new StringBuilder();
        sb.Append("=== [").Append(ts).Append("] ").Append(Agent).Append(' ').Append(Type).Append(task).Append(" ===\n");
        if (ClockSkewNote is { } skewNote)
        {
            sb.Append("-- ").Append(skewNote).Append('\n');
        }

        sb.Append(Msg ?? "");
        if (!string.IsNullOrEmpty(Ref))
        {
            sb.Append("\n- ref: ").Append(Ref);
        }

        if (!string.IsNullOrEmpty(Next))
        {
            sb.Append("\n- next: ").Append(Next);
        }

        if (!string.IsNullOrEmpty(To))
        {
            sb.Append("\n- to: ").Append(To);
        }

        if (!string.IsNullOrEmpty(Prio))
        {
            sb.Append("\n- prio: ").Append(Prio);
        }

        if (!string.IsNullOrEmpty(AgentId) && !string.Equals(AgentId, Agent, StringComparison.OrdinalIgnoreCase))
        {
            sb.Append("\n- agentId: ").Append(AgentId);
        }

        return sb.ToString();
    }
}
