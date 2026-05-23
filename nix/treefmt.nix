{
  inputs,
  lib,
  ...
}:
{
  perSystem =
    { system, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };
    in
    {
      treefmt = {
        inherit pkgs;
        projectRootFile = ".git/config";

        programs = {
          deadnix.enable = true;
          nixfmt.enable = true;
          statix.enable = true;
          typos = {
            enable = true;
            configFile = "./typos.toml";
          };
        };

        settings.formatter = {
          deadnix.priority = 1;
          oxfmt = {
            command = lib.getExe pkgs.oxfmt;
            options = [ "--no-error-on-unmatched-pattern" ];
            includes = [ "*" ];
            priority = 4;
          };
          oxlint = {
            command = lib.getExe pkgs.oxlint;
            options = [ "--fix" ];
            includes = [
              "*.cjs"
              "*.js"
              "*.jsx"
              "*.mjs"
              "*.ts"
              "*.tsx"
            ];
            priority = 5;
          };
          statix.priority = 2;
          nixfmt.priority = 3;
        };
      };
    };
}
