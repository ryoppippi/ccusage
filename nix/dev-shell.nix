{ inputs, lib, ... }:
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
    in
    {
      devShells.default = pkgs.mkShell {
        buildInputs =
          (with pkgs; [
            pnpm_11
            bun

            rustToolchain
            cargo-edit
            cargo-insta
            cargo-llvm-cov
            mold
            pkg-config
            openssl
            config.treefmt.build.wrapper
            nixfmt
            deadnix
            statix
            typos
            typos-lsp
            oxfmt
            actionlint
            zizmor
            oxlint
            just
            prek
            gitleaks
            renovate
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
          ])
          ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
          ]
          ++ config.pre-commit.settings.enabledPackages;

        shellHook = ''
          if [ "$(uname -s)" = "Linux" ]; then
            export RUSTFLAGS="''${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=-fuse-ld=mold"
          fi
          if [ ! -f node_modules/.pnpm/lock.yaml ] || [ pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; then
            echo "📦 Installing dependencies..."
            pnpm install --frozen-lockfile
          fi
          ${lib.getExe config.packages.syncAgentSkills}
          ${config.pre-commit.shellHook}
        '';
      };
    };
}
