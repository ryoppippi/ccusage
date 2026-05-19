{
  description = "Usage analysis tool for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.crane.url = "github:ipetkov/crane";
  inputs.litellm-pricing = {
    url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
    flake = false;
  };
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, crane, litellm-pricing, nixpkgs, rust-overlay, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          let
            pkgs = import nixpkgs {
              inherit system;
              overlays = [ rust-overlay.overlays.default ];
            };
          in f system pkgs);
    in {
      apps = forAllSystems (system: pkgs:
        let
          package = nixpkgs.lib.getExe' self.packages.${system}.ccusage "ccusage";
        in {
          default = {
            type = "app";
            program = package;
          };
          ccusage = {
            type = "app";
            program = package;
          };
          update-pricing-fallback = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${system}.update-pricing-fallback;
          };
        });

      packages = forAllSystems (system: pkgs:
        let
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
          craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = pkgs.lib.cleanSourceWith {
            src = ./rust;
            filter = path: type:
              (craneLib.filterCargoSources path type)
              || pkgs.lib.hasSuffix "/litellm-pricing-fallback.json" path;
          };
          commonArgs = {
            pname = "ccusage";
            inherit version;
            inherit src;
            strictDeps = true;
            doCheck = false;
            cargoExtraArgs = "-p ccusage --bin ccusage";
            CCUSAGE_PRICING_JSON_PATH = litellm-pricing;
            nativeBuildInputs = with pkgs; [
              pkg-config
            ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [
              pkgs.apple-sdk_15
              pkgs.libiconv
            ];
          };
          cargoArtifacts = craneLib.buildDepsOnly commonArgs;
          ccusage = craneLib.buildPackage (commonArgs // {
            inherit cargoArtifacts;
            meta = {
              description = "Analyze coding agent CLI token usage and costs from local data";
              homepage = "https://github.com/ryoppippi/ccusage";
              license = pkgs.lib.licenses.mit;
              mainProgram = "ccusage";
            };
          });
          update-pricing-fallback = pkgs.writeShellApplication {
            name = "update-pricing-fallback";
            runtimeInputs = with pkgs; [ coreutils git jq ];
            text = ''
              repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              target="$repo_root/rust/crates/ccusage/src/litellm-pricing-fallback.json"
              if [ ! -f "$target" ]; then
                echo "fallback pricing file not found: $target" >&2
                exit 1
              fi
              tmp="$(mktemp "$repo_root/rust/crates/ccusage/src/litellm-pricing-fallback.XXXXXX.json")"
              jq --tab -f ${./nix/pricing-fallback.jq} ${litellm-pricing} > "$tmp"
              mv "$tmp" "$target"
            '';
          };
          pricing-fallback-sync = pkgs.runCommand "pricing-fallback-sync" {
            nativeBuildInputs = with pkgs; [ diffutils jq ];
          } ''
            jq --tab -f ${./nix/pricing-fallback.jq} ${litellm-pricing} > generated.json
            diff -u ${./rust/crates/ccusage/src/litellm-pricing-fallback.json} generated.json
            touch $out
          '';
        in {
          default = ccusage;
          inherit ccusage pricing-fallback-sync update-pricing-fallback;
        });

      checks = forAllSystems (system: pkgs: {
        inherit (self.packages.${system}) ccusage;
        inherit (self.packages.${system}) pricing-fallback-sync;
      });

      devShells = forAllSystems (_system: pkgs: {
        default =
        let
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in pkgs.mkShell {
          buildInputs = with pkgs; [
            # Package manager
            pnpm_11

            # Development tools
            rustToolchain
            pkg-config
            openssl
            typos
            typos-lsp
            jq
            git
            gh
            hyperfine
            similarity
            ast-grep
            ripgrep
            fd
            fzf
            delta
            dust
          ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            apple-sdk_15
          ];

          shellHook = ''
            # Install dependencies only if node_modules/.pnpm/lock.yaml is older than pnpm-lock.yaml
            if [ ! -f node_modules/.pnpm/lock.yaml ] || [ pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; then
              echo "📦 Installing dependencies..."
              pnpm install --frozen-lockfile
            fi
          '';
        };
      });
    };
}
