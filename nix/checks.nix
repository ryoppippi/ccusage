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
        root = inputs.self;
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
      checks = {
        inherit ccusage-clippy ccusage-fmt;
        ccusage = config.packages.ccusage;
        oxlint = mkRepoCheck "oxlint-check" [ pkgs.oxlint ] ''
          oxlint .
        '';
        gitleaks = mkRepoCheck "gitleaks-check" [ pkgs.gitleaks ] ''
          gitleaks detect --source . --config .gitleaks.toml --no-git
        '';
      };
    };
}
