{
  inputs,
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
    in
    pkgs.lib.mkIf pkgs.stdenv.isLinux {
      packages.ccusage-static =
        let
          linuxStaticTarget =
            if system == "x86_64-linux" then "x86_64-unknown-linux-musl" else "aarch64-unknown-linux-musl";
          staticPkgs =
            if system == "x86_64-linux" then
              pkgs.pkgsCross.musl64
            else
              pkgs.pkgsCross.aarch64-multiplatform-musl;
          staticCraneLib = (inputs.crane.mkLib staticPkgs).overrideToolchain (
            p:
            (p.rust-bin.fromRustupToolchainFile (root + /rust-toolchain.toml)).override {
              targets = [ linuxStaticTarget ];
            }
          );
          staticCommonArgs = config.packages.ccusage.passthru.commonArgs // {
            cargoExtraArgs = "-p ccusage --bin ccusage --target ${linuxStaticTarget}";
            nativeBuildInputs = with staticPkgs; [
              pkg-config
            ];
            buildInputs = with staticPkgs; [
              openssl
            ];
            OPENSSL_STATIC = "1";
            PKG_CONFIG_ALLOW_CROSS = "1";
          };
          staticCargoArtifacts = staticCraneLib.buildDepsOnly staticCommonArgs;
        in
        staticCraneLib.buildPackage (
          staticCommonArgs
          // {
            cargoArtifacts = staticCargoArtifacts;
            meta = config.packages.ccusage.meta // {
              description = "Static Linux build of ccusage";
            };
          }
        );
    };
}
