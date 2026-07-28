# Docker-CI edge-case harness for the lbabus coordination CLI.
#
# The runner (ci/LbaBus.Ci) executes the declarative cases/*.json against a freshly built lbabus and
# fails the image build if any case fails — so wiring these targets into the release pipeline gates a
# publish on the harness. Two runtime stages exercise the ripgrep-present and ripgrep-absent paths.
#
#   docker build -f tools/collab-cli/ci/Dockerfile --target ci-rg    .
#   docker build -f tools/collab-cli/ci/Dockerfile --target ci-no-rg .
#
# Mock-requiring cases (version-guard-*, defect-*) SKIP here because no LBABUS_GITHUB_API mock is wired
# yet. The Linux plane adds the in-container GitHub mock (see ci/README.md — "Mock contract") and points
# LBABUS_GITHUB_API at it so those cases run; the mock speaks the same {base}/graphql + {base}/repos/...
# surface documented there.

# ---- build stage: publish the CLI and the runner --------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish tools/collab-cli/LbaBus.csproj -c Release -o /out/cli \
 && dotnet publish tools/collab-cli/ci/LbaBus.Ci/LbaBus.Ci.csproj -c Release -o /out/ci

# ---- ci-rg: ripgrep present -> offline cases PASS, mock cases SKIP, no-rg case SKIP ----------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-rg
# ripgrep is the one pinned tool the offline grep cases need (git ships in the sdk image).
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /out
COPY tools/collab-cli/ci /repo/tools/collab-cli/ci
RUN dotnet /out/ci/lbabus-ci.dll --repo-root /repo --lbabus /out/cli/lbabus.dll

# ---- ci-no-rg: ripgrep deliberately absent -> the ripgrep-only fail-closed (exit 4) case RUNS ------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-no-rg
COPY --from=build /out /out
COPY tools/collab-cli/ci /repo/tools/collab-cli/ci
RUN dotnet /out/ci/lbabus-ci.dll --repo-root /repo --lbabus /out/cli/lbabus.dll
