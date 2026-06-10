{
  craneLib,
  inputs,
  lib,
  pkg-config,
  root ? ./.,
  stdenv,
  apple-sdk_15,
  libiconv,
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
    nativeBuildInputs = [
      pkg-config
    ];
    buildInputs = lib.optionals stdenv.isDarwin [
      apple-sdk_15
      libiconv
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
      install_name_tool -change ${libiconv}/lib/libiconv.2.dylib /usr/lib/libiconv.2.dylib $out/bin/ccusage
      # End-user machines have no /nix/store, so any dylib outside the macOS
      # system paths would crash the published binary with a missing dynamic
      # library error. grep prints the offending entries when it matches.
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
