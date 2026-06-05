{
  craneLib,
  inputs,
  lib,
  pkg-config,
  root ? ./.,
  stdenv,
  apple-sdk_15,
  libiconv,
  openssl,
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
      || lib.hasSuffix "/fast-multiplier-overrides.json" path;
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
    buildInputs =
      lib.optionals stdenv.isDarwin [
        apple-sdk_15
        libiconv
      ]
      ++ lib.optionals stdenv.isLinux [
        openssl
      ];
  };
  cargoArtifacts = craneLib.buildDepsOnly commonArgs;
in
craneLib.buildPackage (
  commonArgs
  // {
    inherit cargoArtifacts;
    passthru = {
      inherit
        cargoArtifacts
        commonArgs
        version
        ;
    };
    meta = {
      description = "Analyze coding agent CLI token usage and costs from local data";
      homepage = "https://github.com/ryoppippi/ccusage";
      license = lib.licenses.mit;
      mainProgram = "ccusage";
    };
  }
)
