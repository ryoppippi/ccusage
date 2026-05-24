{
  inputs,
  lib,
  ...
}:
let
  root = ./..;
in
{
  perSystem =
    { system, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ inputs.rust-overlay.overlays.default ];
      };
      rustToolchain = pkgs.rust-bin.fromRustupToolchainFile (root + /rust-toolchain.toml);
      schemaGen = pkgs.writeShellApplication {
        name = "ccusage-schema-gen";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.oxfmt
          pkgs.openssl
          pkgs.pkg-config
          rustToolchain
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.apple-sdk_15
          pkgs.libiconv
        ];
        text = ''
          ${lib.optionalString pkgs.stdenv.isDarwin ''
            export SDKROOT="${pkgs.apple-sdk_15}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
            export LIBRARY_PATH="${
              lib.makeLibraryPath [
                pkgs.libiconv
                pkgs.openssl
              ]
            }:''${LIBRARY_PATH:-}"
            export CPATH="${
              lib.makeIncludePath [
                pkgs.libiconv
                pkgs.openssl
              ]
            }:''${CPATH:-}"
          ''}

          cargo run --quiet --manifest-path rust/Cargo.toml --bin generate-config-schema -- apps/ccusage/config-schema.json
          oxfmt --write apps/ccusage/config-schema.json
          cp apps/ccusage/config-schema.json docs/public/config-schema.json
        '';
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
          schema-gen = {
            command = lib.getExe schemaGen;
            includes = [
              "apps/ccusage/config-schema.json"
              "rust/crates/ccusage/src/config_schema.rs"
              "rust/crates/ccusage/src/bin/generate_config_schema.rs"
            ];
            priority = 0;
          };
          deadnix.priority = 1;
          statix.priority = 2;
          nixfmt.priority = 3;
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
          rustfmt = {
            command = lib.getExe' rustToolchain "rustfmt";
            options = [
              "--edition"
              "2021"
            ];
            includes = [ "*.rs" ];
            priority = 6;
          };
        };
      };
    };
}
