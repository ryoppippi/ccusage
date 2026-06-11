# Rust coverage report built as a Nix derivation so it shares the crane
# `cargoArtifacts` cache (warm on the per-job Blacksmith sticky disk) instead of
# the dev-shell's `cargo llvm-cov`, which recompiled the whole workspace into an
# uncached `rust/target` on every CI run. Output is the cobertura XML file at
# `$out`, consumed by the coverage upload step in CI via `nix build`.
{ inputs, ... }:
let
  root = ./..;
in
{
  perSystem =
    {
      config,
      system,
      ...
    }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };
      rustToolchain = pkgs.rust-bin.fromRustupToolchainFile (root + /rust-toolchain.toml);
      craneLib = (inputs.crane.mkLib pkgs).overrideToolchain rustToolchain;
      inherit (config.packages.ccusage.passthru) cargoArtifacts commonArgs;
      nixFilter = inputs.nix-filter.lib;
      repoSrc = nixFilter {
        inherit root;
        exclude = [
          (nixFilter.matchName "node_modules")
          (nixFilter.matchName "target")
          (nixFilter.matchName "dist")
          (nixFilter.matchName "coverage")
        ];
      };
    in
    {
      packages.ccusage-coverage = craneLib.cargoLlvmCov (
        commonArgs
        // {
          src = repoSrc;
          sourceRoot = "source/rust";
          cargoLock = root + /rust/Cargo.lock;
          inherit cargoArtifacts;
          cargoExtraArgs = "--workspace";
          cargoLlvmCovExtraArgs = "--cobertura --output-path $out";
          # jiff resolves named time zones (e.g. Asia/Tokyo) from the system
          # zoneinfo database, which the hermetic build sandbox lacks, so it
          # would fall back to UTC and shift the timezone-dependent tests by a
          # day. Point it at the nixpkgs tzdata; referencing the store path here
          # also pulls it into the sandbox as a build input.
          TZDIR = "${pkgs.tzdata}/share/zoneinfo";
          # The workspace tests resolve default Claude data directories from
          # $HOME; the sandbox has none, so seed a writable HOME with the same
          # empty directory layout the CI test job creates before running tests.
          preBuild = ''
            export HOME=$(mktemp -d)
            mkdir -p "$HOME/.claude/projects" "$HOME/.config/claude/projects"
          '';
        }
      );
    };
}
