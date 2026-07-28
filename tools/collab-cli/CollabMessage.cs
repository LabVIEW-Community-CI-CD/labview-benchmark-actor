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
    [JsonPropertyName("ts")] public string Ts { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "NOTE";
    [JsonPropertyName("task")] public string? Task { get; set; }
    [JsonPropertyName("msg")] public string? Msg { get; set; }
    [JsonPropertyName("ref")] public string? Ref { get; set; }
    [JsonPropertyName("next")] public string? Next { get; set; }
    [JsonPropertyName("to")] public string? To { get; set; }

    /// <summary>Server-side comment creation time (populated when read back from a discussion).</summary>
    [JsonIgnore] public DateTimeOffset? CreatedAt { get; set; }

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

        sb.Append("\n```json\n").Append(JsonSerializer.Serialize(this, JsonOptions)).Append("\n```\n");
        return sb.ToString();
    }

    private static readonly Regex JsonBlock = new(
        "\\{[^{}]*\"schema\"\\s*:\\s*\"vihs-collab-msg@v1\"[^{}]*\\}",
        RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// Parse a message from a raw comment body. Returns null when the body has no
    /// <c>vihs-collab-msg@v1</c> JSON block (e.g. a human comment).
    /// </summary>
    public static CollabMessage? TryParse(string rawBody, DateTimeOffset? createdAt = null)
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
        string body = (Msg ?? "").Replace("\r", " ").Replace("\n", " ");
        if (body.Length > 240)
        {
            body = body[..240] + "…";
        }

        return $"[{ts}] {Agent} {Type}{task} — {body}".TrimEnd();
    }
}
