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
            nodejs
            pnpm
            nushell

            rustToolchain
            cargo-edit
            cargo-insta
            cargo-llvm-cov
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
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.mold
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
          ]
          ++ config.pre-commit.settings.enabledPackages;

        shellHook = ''
          if [ "$(uname -s)" = "Linux" ]; then
            case " ''${RUSTFLAGS:-} " in
              *" -C link-arg=-fuse-ld=mold "*) ;;
              *) export RUSTFLAGS="''${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=-fuse-ld=mold" ;;
            esac
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
