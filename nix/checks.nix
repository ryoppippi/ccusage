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
      inherit (config.packages.ccusage.passthru)
        cargoArtifacts
        commonArgs
        version
        ;
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
      ccusage-clippy = craneLib.cargoClippy (
        commonArgs
        // {
          src = repoSrc;
          sourceRoot = "source/rust";
          cargoLock = root + /rust/Cargo.lock;
          inherit cargoArtifacts;
          cargoExtraArgs = "--workspace";
          cargoClippyExtraArgs = "--all-targets -- -D warnings";
        }
      );
      ccusage-fmt = craneLib.cargoFmt {
        pname = "ccusage-rust";
        inherit version;
        src = repoSrc;
        sourceRoot = "source/rust";
        cargoExtraArgs = "--all";
      };
      # Build the schema generator straight from the current Rust source so the
      # drift check below can never go stale: it always reflects whatever
      # `rust/crates/ccusage/src/config_schema.rs` looks like right now.
      generateConfigSchema = craneLib.buildPackage (
        commonArgs
        // {
          pname = "generate-config-schema";
          inherit cargoArtifacts;
          cargoExtraArgs = "-p ccusage --bin generate-config-schema";
          doCheck = false;
          meta = {
            mainProgram = "generate-config-schema";
          };
        }
      );
      # Fail `nix flake check` when the committed config schema drifts from what
      # the Rust source generates. This catches PRs that add or change a config
      # field without regenerating the schema (run
      # `pnpm --filter ccusage run generate:schema` to fix). Only the tracked
      # apps/ccusage/config-schema.json is checked; docs/public/config-schema.json
      # is a gitignored build copy.
      config-schema =
        pkgs.runCommand "config-schema-check"
          {
            src = repoSrc;
            nativeBuildInputs = [
              generateConfigSchema
              pkgs.oxfmt
              pkgs.diffutils
            ];
          }
          ''
            cp -R "$src" source
            chmod -R u+w source
            cd source

            generate-config-schema generated.json
            oxfmt --write generated.json

            if ! diff -u apps/ccusage/config-schema.json generated.json; then
              echo "ERROR: apps/ccusage/config-schema.json is out of sync with the Rust schema source." >&2
              echo "Run 'nix run .#generate-schema' (or 'pnpm --filter ccusage run generate:schema') and commit the result." >&2
              exit 1
            fi

            touch "$out"
          '';
      mkRepoCheck =
        name: nativeBuildInputs: command:
        pkgs.runCommand name
          {
            src = repoSrc;
            inherit nativeBuildInputs;
          }
          ''
            cp -R "$src" source
            chmod -R u+w source
            cd source
            ${command}
            touch "$out"
          '';
    in
    {
      # `nix flake check` deliberately omits a full `config.packages.ccusage`
      # build: ccusage-clippy already compiles the entire workspace with
      # `--all-targets` (catching any build break), and the build-native-packages
      # CI job produces and verifies the actual release binary. Building the
      # optimized native package here too only duplicated a ~70s release compile
      # on cache-cold runners.
      checks = {
        inherit ccusage-clippy ccusage-fmt config-schema;
        oxlint = mkRepoCheck "oxlint-check" [ pkgs.oxlint ] ''
          oxlint .
        '';
        gitleaks = mkRepoCheck "gitleaks-check" [ pkgs.gitleaks ] ''
          gitleaks detect --source . --config .gitleaks.toml --no-git
        '';
        config-example = mkRepoCheck "config-example-check" [ pkgs.check-jsonschema ] ''
          check-jsonschema --schemafile apps/ccusage/config-schema.json ccusage.example.json
        '';
      };
    };
}
