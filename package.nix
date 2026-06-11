{
  craneLib,
  inputs,
  lib,
  mold,
  pkg-config,
  root ? ./.,
  stdenv,
  apple-sdk_15,
}:
let
  inherit ((builtins.fromJSON (builtins.readFile (root + /package.json)))) version;
  src = lib.cleanSourceWith {
    src = root + /rust;
    filter =
      path: type:
      (craneLib.filterCargoSources path type)
      || lib.hasSuffix "/cli-help.json" path
      || lib.hasSuffix "/cli-commands.json" path
      || lib.hasSuffix "/fast-multiplier-overrides.json" path
      || lib.hasSuffix "/models-dev-pricing.json" path;
  };
  commonArgs = {
    pname = "ccusage";
    inherit version src;
    strictDeps = true;
    doCheck = false;
    cargoExtraArgs = "-p ccusage --bin ccusage";
    CCUSAGE_PRICING_JSON_PATH = "${inputs.litellm}/model_prices_and_context_window.json";
    RUSTFLAGS = lib.optionalString stdenv.isLinux "-C link-arg=-fuse-ld=mold";
    nativeBuildInputs = [
      pkg-config
    ]
    ++ lib.optionals stdenv.isLinux [ mold ];
    buildInputs = lib.optionals stdenv.isDarwin [
      apple-sdk_15
    ];
  };
  # Keep the dependency artifact keyed only by inputs that affect Cargo deps.
  # Pricing snapshots and release versions are embedded by the final package.
  depsOnlyArgs = builtins.removeAttrs commonArgs [ "CCUSAGE_PRICING_JSON_PATH" ] // {
    version = "0.0.0";
  };
  cargoArtifacts = craneLib.buildDepsOnly depsOnlyArgs;
in
craneLib.buildPackage (
  commonArgs
  // {
    inherit cargoArtifacts;
    postInstall = lib.optionalString stdenv.isDarwin ''
      # ccusage does not use libiconv (no iconv symbols); it used to be pulled in
      # via buildInputs and recorded as an unused /nix/store dylib dependency
      # that crashed non-Nix Macs (#1251). With libiconv dropped the binary links
      # only system dylibs. Keep this gate so any future stray /nix/store dylib
      # fails the build instead of shipping. grep prints the offending entries.
      if otool -L $out/bin/ccusage | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)'; then
        echo "error: ccusage links dylibs that do not exist on end-user machines" >&2
        exit 1
      fi
    '';
    passthru = {
      inherit
        cargoArtifacts
        commonArgs
        depsOnlyArgs
        version
        ;
    };
    meta = {
      description = "Analyze coding agent CLI token usage and costs from local data";
      homepage = "https://github.com/ccusage/ccusage";
      license = lib.licenses.mit;
      mainProgram = "ccusage";
    };
  }
)
