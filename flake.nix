{
  description = "Usage analysis tool for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.crane.url = "github:ipetkov/crane";
  inputs.litellm = {
    url = "github:BerriAI/litellm";
    flake = false;
  };
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, crane, litellm, nixpkgs, rust-overlay, ... }:
    let
      litellm-pricing = "${litellm}/model_prices_and_context_window.json";
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          let
            pkgs = import nixpkgs {
              inherit system;
              overlays = [ rust-overlay.overlays.default ];
            };
          in f system pkgs);
      mkRepoSrc = pkgs: pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            rel = pkgs.lib.removePrefix "${toString ./.}/" (toString path);
          in
            !(pkgs.lib.hasPrefix "node_modules/" rel)
            && !(pkgs.lib.hasPrefix "target/" rel)
            && !(pkgs.lib.hasPrefix "dist/" rel)
            && !(pkgs.lib.hasPrefix "coverage/" rel);
      };
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
              || pkgs.lib.hasSuffix "/cli-help.json" path
              || pkgs.lib.hasSuffix "/fast-multiplier-overrides.json" path
              || pkgs.lib.hasSuffix "/litellm-pricing-fallback.json" path;
          };
          repoSrc = mkRepoSrc pkgs;
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
          ccusage-clippy = craneLib.cargoClippy (commonArgs // {
            src = repoSrc;
            sourceRoot = "source/rust";
            cargoLock = ./rust/Cargo.lock;
            inherit cargoArtifacts;
            cargoExtraArgs = "--workspace";
            cargoClippyExtraArgs = "--all-targets -- -D warnings";
          });
          ccusage-fmt = craneLib.cargoFmt {
            pname = "ccusage-rust";
            inherit version;
            src = repoSrc;
            sourceRoot = "source/rust";
            cargoExtraArgs = "--all";
          };
          staticCcusage = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux (
            let
              linuxStaticTarget =
                if system == "x86_64-linux"
                then "x86_64-unknown-linux-musl"
                else "aarch64-unknown-linux-musl";
              staticPkgs =
                if system == "x86_64-linux"
                then pkgs.pkgsCross.musl64
                else pkgs.pkgsCross.aarch64-multiplatform-musl;
              staticCraneLib = (crane.mkLib staticPkgs).overrideToolchain
                (p: (p.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml).override {
                  targets = [ linuxStaticTarget ];
                });
              staticCommonArgs = commonArgs // {
                cargoExtraArgs = "-p ccusage --bin ccusage --target ${linuxStaticTarget}";
                nativeBuildInputs = with staticPkgs; [
                  pkg-config
                ];
                buildInputs = [ ];
              };
              staticCargoArtifacts = staticCraneLib.buildDepsOnly staticCommonArgs;
            in {
              ccusage-static = staticCraneLib.buildPackage (staticCommonArgs // {
                cargoArtifacts = staticCargoArtifacts;
                meta = ccusage.meta // {
                  description = "Static Linux build of ccusage";
                };
              });
            }
          );
          update-pricing-fallback = pkgs.writeShellApplication {
            name = "update-pricing-fallback";
            runtimeInputs = with pkgs; [ coreutils git jq oxfmt ];
            text = ''
              repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              target="$repo_root/rust/crates/ccusage/src/litellm-pricing-fallback.json"
              if [ ! -f "$target" ]; then
                echo "fallback pricing file not found: $target" >&2
                exit 1
              fi
              tmp="$(mktemp "$repo_root/rust/crates/ccusage/src/litellm-pricing-fallback.XXXXXX.json")"
              jq --tab -f ${./nix/pricing-fallback.jq} ${litellm-pricing} > "$tmp"
              oxfmt --config ${./.oxfmtrc.json} --write "$tmp"
              mv "$tmp" "$target"
            '';
          };
          pricing-fallback-sync = pkgs.runCommand "pricing-fallback-sync" {
            nativeBuildInputs = with pkgs; [ diffutils jq oxfmt ];
          } ''
            jq --tab -f ${./nix/pricing-fallback.jq} ${litellm-pricing} > generated.json
            oxfmt --config ${./.oxfmtrc.json} --write generated.json
            diff -u ${./rust/crates/ccusage/src/litellm-pricing-fallback.json} generated.json
            touch $out
          '';
        in {
          default = ccusage;
          inherit ccusage ccusage-clippy ccusage-fmt pricing-fallback-sync update-pricing-fallback;
        } // staticCcusage);

      checks = forAllSystems (system: pkgs:
        let
          repoSrc = mkRepoSrc pkgs;
          mkRepoCheck = name: nativeBuildInputs: command:
            pkgs.runCommand name {
              src = repoSrc;
              inherit nativeBuildInputs;
            } ''
              cp -R "$src" source
              chmod -R u+w source
              cd source
              ${command}
              touch "$out"
            '';
        in {
          inherit (self.packages.${system}) ccusage;
          inherit (self.packages.${system}) ccusage-clippy;
          inherit (self.packages.${system}) ccusage-fmt;
          inherit (self.packages.${system}) pricing-fallback-sync;
          oxfmt = mkRepoCheck "oxfmt-check" [ pkgs.oxfmt ] ''
            oxfmt --check .
          '';
          oxlint = mkRepoCheck "oxlint-check" [ pkgs.oxlint ] ''
            oxlint .
          '';
          typos = mkRepoCheck "typos-check" [ pkgs.typos ] ''
            typos --config ./typos.toml
          '';
          gitleaks = mkRepoCheck "gitleaks-check" [ pkgs.gitleaks ] ''
            gitleaks detect --source . --config .gitleaks.toml --no-git
          '';
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
            cargo-edit
            pkg-config
            openssl
            typos
            typos-lsp
            oxfmt
            oxlint
            lefthook
            gitleaks
            typescript-go
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
            lefthook install
          '';
        };
      });
    };
}
