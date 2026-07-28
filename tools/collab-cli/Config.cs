using System.Runtime.InteropServices;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Bus target + identity, resolved from environment variables. Backward-compatible with the
/// legacy <c>prototype/collab.mjs</c> variables so a mixed fleet interoperates during migration.
/// </summary>
public sealed class Config
{
    public string Owner { get; }
    public string Repo { get; }
    public string Category { get; }
    public string Title { get; }
    public string Agent { get; }
    public string AgentId { get; }

    private Config(string owner, string repo, string category, string title, string agent, string agentId)
    {
        Owner = owner;
        Repo = repo;
        Category = category;
        Title = title;
        Agent = agent;
        AgentId = agentId;
    }

    public static Config FromEnvironment()
    {
        string owner = Env("VIHS_COLLAB_OWNER", "LabVIEW-Community-CI-CD");
        string repo = Env("VIHS_COLLAB_REPO", "labview-benchmark-actor");
        string category = Env("VIHS_COLLAB_CATEGORY", "General");
        string title = Env("VIHS_COLLAB_TITLE", "labview-benchmark-actor coordination bus (WIN <-> LINUX)");
        string agent = DeriveAgent();
        string agentId = Env("VIHS_COLLAB_AGENT_ID", agent);
        return new Config(owner, repo, category, title, agent, agentId);
    }

    /// <summary>The counterpart agent label (the one this agent waits on by default).</summary>
    public string Counterpart => Agent.Equals("LINUX", StringComparison.OrdinalIgnoreCase) ? "WIN" : "LINUX";

    /// <summary>
    /// True when a message's <c>to</c> field addresses THIS agent (LBA-REQ-013): a broadcast
    /// (empty/absent <c>to</c>) reaches everyone, otherwise the <c>to</c> must equal this agent's
    /// plane label or its fine-grained <see cref="AgentId"/>. Backs the <c>--to-me</c> filter.
    /// </summary>
    public bool AddressesMe(string? to)
    {
        if (string.IsNullOrWhiteSpace(to))
        {
            return true;
        }

        string t = to.Trim();
        return t.Equals(Agent, StringComparison.OrdinalIgnoreCase)
            || t.Equals(AgentId, StringComparison.OrdinalIgnoreCase);
    }

    private static string DeriveAgent()
    {
        string? explicitAgent = Environment.GetEnvironmentVariable("VIHS_COLLAB_AGENT");
        if (!string.IsNullOrWhiteSpace(explicitAgent))
        {
            return explicitAgent.Trim().ToUpperInvariant();
        }

        return RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "WIN" : "LINUX";
    }

    private static string Env(string name, string fallback)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}
