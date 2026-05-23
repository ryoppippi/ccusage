{
  inputs,
  lib,
  ...
}:
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
      syncSkillsNix = import ./sync-skills.nix { inherit pkgs; };
      checkConfigSchema = pkgs.writeShellApplication {
        name = "ccusage-hook-check-config-schema";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.oxfmt
          pkgs.openssl
          pkgs.pkg-config
          rustToolchain
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.apple-sdk_15
          pkgs.libiconv
        ];
        text = ''
          tmp_dir="$(mktemp -d)"
          trap 'rm -rf "$tmp_dir"' EXIT

          generated_schema="$tmp_dir/config-schema.json"
          generated_docs_schema="$tmp_dir/docs-config-schema.json"

          ${lib.optionalString pkgs.stdenv.isDarwin ''
            export SDKROOT="${pkgs.apple-sdk_15}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
            export LIBRARY_PATH="${
              lib.makeLibraryPath [
                pkgs.libiconv
                pkgs.openssl
              ]
            }:''${LIBRARY_PATH:-}"
            export CPATH="${
              lib.makeIncludePath [
                pkgs.libiconv
                pkgs.openssl
              ]
            }:''${CPATH:-}"
          ''}

          cargo run --quiet --manifest-path rust/Cargo.toml --bin generate-config-schema -- "$generated_schema"
          oxfmt --write "$generated_schema"
          cp "$generated_schema" "$generated_docs_schema"

          has_errors=0
          if ! cmp -s "$generated_schema" apps/ccusage/config-schema.json; then
            echo "apps/ccusage/config-schema.json is out of date." >&2
            has_errors=1
          fi
          if ! cmp -s "$generated_docs_schema" docs/public/config-schema.json; then
            echo "docs/public/config-schema.json is out of date." >&2
            has_errors=1
          fi
          if [ "$has_errors" -eq 1 ]; then
            echo "Run: pnpm --filter ccusage run generate:schema" >&2
            exit 1
          fi
          echo "Config schema is up to date"
        '';
      };
    in
    {
      pre-commit = {
        check.enable = false;
        inherit pkgs;
        settings = {
          src = root;
          package = pkgs.prek;
          hooks = {
            sync-skills = {
              enable = true;
              name = "sync skills";
              entry = lib.getExe syncSkillsNix;
              files = "^\\.agents/skills/|^\\.claude/skills/";
              pass_filenames = false;
              stages = [ "pre-commit" ];
              priority = 0;
            };
            sync-skills-check = {
              enable = true;
              name = "sync skills check";
              entry = "${lib.getExe syncSkillsNix} --check";
              files = "^\\.agents/skills/|^\\.claude/skills/";
              pass_filenames = false;
              stages = [
                "pre-commit"
                "pre-push"
              ];
              priority = 1;
            };
            config-schema = {
              enable = true;
              name = "config schema";
              entry = lib.getExe checkConfigSchema;
              files = "^(apps/ccusage/package\\.json|rust/crates/ccusage/src/config_schema\\.rs|rust/crates/ccusage/src/bin/generate_config_schema\\.rs)$";
              pass_filenames = false;
              stages = [ "pre-commit" ];
              priority = 0;
            };
            renovate-config-validator = {
              enable = true;
              entry = "${lib.getExe pkgs.renovate} --strict config-validator";
              files = "renovate\\.json5?$";
              pass_filenames = false;
              stages = [
                "pre-commit"
                "pre-push"
              ];
              priority = 0;
            };
            ccusage-treefmt = {
              enable = true;
              name = "treefmt";
              entry = lib.getExe config.treefmt.build.wrapper;
              files = ".*";
              stages = [ "pre-commit" ];
              priority = 10;
            };
            gitleaks-protect = {
              enable = true;
              name = "gitleaks";
              entry = "${lib.getExe pkgs.gitleaks} protect --staged --config .gitleaks.toml";
              pass_filenames = false;
              always_run = true;
              stages = [ "pre-commit" ];
              priority = 20;
            };
            ccusage-rustfmt = {
              enable = true;
              name = "rustfmt";
              entry = lib.getExe' rustToolchain "rustfmt";
              files = "^rust/.*\\.rs$";
              stages = [ "pre-commit" ];
              priority = 10;
            };
            ccusage-treefmt-check = {
              enable = true;
              name = "treefmt";
              entry = "${lib.getExe config.treefmt.build.wrapper} --fail-on-change";
              files = ".*";
              pass_filenames = false;
              stages = [ "pre-push" ];
              priority = 0;
            };
            gitleaks-detect = {
              enable = true;
              name = "gitleaks";
              entry = "${lib.getExe pkgs.gitleaks} detect --config .gitleaks.toml";
              files = ".*";
              pass_filenames = false;
              always_run = true;
              stages = [ "pre-push" ];
              priority = 0;
            };
            ccusage-oxlint-check = {
              enable = true;
              name = "oxlint";
              entry = "${lib.getExe pkgs.oxlint} .";
              files = "\\.(ts|tsx|js|jsx|mjs|cjs)$";
              pass_filenames = false;
              stages = [ "pre-push" ];
              priority = 0;
            };
            ccusage-clippy = {
              enable = true;
              name = "clippy";
              entry = "${lib.getExe' rustToolchain "cargo"} clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings";
              files = "^rust/.*\\.rs$";
              pass_filenames = false;
              stages = [ "pre-push" ];
              priority = 0;
            };
            vitest-related = {
              enable = true;
              name = "vitest related";
              entry = "${lib.getExe pkgs.pnpm_11} vitest related --run";
              files = "\\.(ts|tsx|js|jsx|mjs|cjs)$";
              stages = [ "pre-push" ];
              priority = 10;
            };
            cargo-test = {
              enable = true;
              name = "cargo test";
              entry = "${lib.getExe' rustToolchain "cargo"} test --manifest-path rust/Cargo.toml --workspace --all-targets";
              files = "^rust/(.*\\.rs|.*Cargo\\.toml|Cargo\\.lock)$";
              pass_filenames = false;
              stages = [ "pre-push" ];
              priority = 10;
            };
          };
        };
      };
    };
}
