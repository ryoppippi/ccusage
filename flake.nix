{
  description = "Usage analysis tool for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: rec {
        default = ccusage;

        ccusage = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "ccusage";
          version = (builtins.fromJSON (builtins.readFile ./apps/ccusage/package.json)).version;

          src = ./.;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 2;
            hash = "sha256-iGdAo6e9zbuJg7Wlyh/zmAXEH/Uod9EaUzDTDygBc0I=";
          };

          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
            pkgs.bun
            pkgs.git
            pkgs.makeWrapper
          ];

          buildPhase = ''
            runHook preBuild

            # The npm `bun` and `node` packages ship prebuilt binaries that
            # can't run under Nix. Drop their shims so PATH falls through to
            # the runtimes from nativeBuildInputs.
            rm -f node_modules/.bin/bun node_modules/.bin/node

            # generate-json-schema.ts calls `git rev-parse --show-toplevel`
            # to copy the schema into docs/public. Nix strips .git from src,
            # so seed an empty repo here to satisfy the lookup.
            git init -q
            git -c user.email=nix@build -c user.name=nix commit --allow-empty -q -m init

            pnpm --filter ccusage build

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/ccusage $out/bin
            cp -r apps/ccusage/dist $out/lib/ccusage/
            cp apps/ccusage/package.json $out/lib/ccusage/
            if [ -f apps/ccusage/config-schema.json ]; then
              cp apps/ccusage/config-schema.json $out/lib/ccusage/
            fi

            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/ccusage \
              --add-flags $out/lib/ccusage/dist/index.js

            runHook postInstall
          '';

          meta = {
            description = "Usage analysis tool for Claude Code";
            homepage = "https://github.com/ryoppippi/ccusage";
            license = pkgs.lib.licenses.mit;
            mainProgram = "ccusage";
            platforms = systems;
          };
        });
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          buildInputs = with pkgs; [
            # Package manager
            pnpm_10

            # Development tools
            typos
            typos-lsp
            jq
            git
            gh
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
