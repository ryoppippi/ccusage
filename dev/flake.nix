{
  description = "Development environment for ccusage";

  inputs = {
    ccusage.url = "path:..";

    nixpkgs.follows = "ccusage/nixpkgs";
    crane.follows = "ccusage/crane";
    flake-parts.follows = "ccusage/flake-parts";
    litellm.follows = "ccusage/litellm";
    models-dev.follows = "ccusage/models-dev";
    nix-filter.follows = "ccusage/nix-filter";
    rust-overlay.follows = "ccusage/rust-overlay";

    agent-skills = {
      url = "github:Kyure-A/agent-skills-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
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
        inputs.treefmt-nix.flakeModule
        inputs.git-hooks.flakeModule
        ../nix/packages.nix
        ../nix/agent-skills.nix
        ../nix/treefmt.nix
        ../nix/git-hooks.nix
        ../nix/dev-shell.nix
      ];
    };
}
