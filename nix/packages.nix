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
      ccusage = import ../default.nix {
        inherit
          craneLib
          inputs
          pkgs
          root
          ;
      };
      ccusageProgram = pkgs.lib.getExe' ccusage "ccusage";
    in
    {
      apps = {
        default = {
          type = "app";
          program = ccusageProgram;
        };
        ccusage = {
          type = "app";
          program = ccusageProgram;
        };
      };

      packages = {
        default = ccusage;
        inherit ccusage;
      };
    };
}
