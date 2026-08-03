using System.Runtime.InteropServices;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Bus identity + the GitHub repo context for the two remaining GitHub-API touchpoints (`selfcheck`
/// release-currency lookup + the `lbabus defect` sink), resolved from environment variables.
/// </summary>
public sealed class Config
{
    public string Owner { get; }
    public string Repo { get; }
    public string Agent { get; }

    private Config(string owner, string repo, string agent)
    {
        Owner = owner;
        Repo = repo;
        Agent = agent;
    }

    public static Config FromEnvironment()
    {
        string owner = Env("VIHS_COLLAB_OWNER", "LabVIEW-Community-CI-CD");
        string repo = Env("VIHS_COLLAB_REPO", "labview-benchmark-actor");
        string agent = DeriveAgent();
        return new Config(owner, repo, agent);
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
