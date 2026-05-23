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
      repoSrc = pkgs.lib.cleanSourceWith {
        src = root;
        filter =
          path: _type:
          let
            rel = pkgs.lib.removePrefix "${toString root}/" (toString path);
          in
          !(pkgs.lib.hasPrefix "node_modules/" rel)
          && !(pkgs.lib.hasPrefix "target/" rel)
          && !(pkgs.lib.hasPrefix "dist/" rel)
          && !(pkgs.lib.hasPrefix "coverage/" rel);
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
