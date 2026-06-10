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
            buildInputs = [ ];
          };
          # Share the same deps-only cache key, then add static target settings.
          staticDepsOnlyArgs = config.packages.ccusage.passthru.depsOnlyArgs // {
            cargoExtraArgs = "-p ccusage --bin ccusage --target ${linuxStaticTarget}";
            nativeBuildInputs = with staticPkgs; [
              pkg-config
            ];
            buildInputs = [ ];
          };
          staticCargoArtifacts = staticCraneLib.buildDepsOnly staticDepsOnlyArgs;
        in
        staticCraneLib.buildPackage (
          staticCommonArgs
          // {
            cargoArtifacts = staticCargoArtifacts;
            # A PT_INTERP header means the binary requests a dynamic loader,
            # so it would not run on end-user machines without the build-time
            # loader path. READELF is exported by the cross bintools wrapper.
            postInstall = ''
              if "''${READELF:-readelf}" -l $out/bin/ccusage | grep -q INTERP; then
                echo "error: ccusage-static is not statically linked" >&2
                exit 1
              fi
            '';
            meta = config.packages.ccusage.meta // {
              description = "Static Linux build of ccusage";
            };
          }
        );
    };
}
