{
  description = "Usage analysis tool for Claude Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    crane.url = "github:ipetkov/crane";
    flake-parts.url = "github:hercules-ci/flake-parts";
    litellm = {
      url = "github:BerriAI/litellm";
      flake = false;
    };
    models-dev = {
      url = "github:anomalyco/models.dev";
      flake = false;
    };
    nix-filter.url = "github:numtide/nix-filter";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      imports = [
        inputs.flake-parts.flakeModules.touchup
        ./nix/packages.nix
        ./nix/static-package.nix
        ./nix/checks.nix
      ];

      touchup.attr.formatter.enable = false;
    };
}
