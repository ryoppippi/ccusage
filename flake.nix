{
  description = "Usage analysis tool for Claude Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, nixpkgs, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Package manager
            pnpm_10

            # Development tools
            typos
            typos-lsp
            jq
            git
            gh
          ];

          shellHook = ''
            # Install dependencies only if node_modules/.pnpm/lock.yaml is older than pnpm-lock.yaml
            if [ ! -f node_modules/.pnpm/lock.yaml ] || [ pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; then
              echo "📦 Installing dependencies..."
              pnpm install --frozen-lockfile
            fi
          '';
        };
      };
    };
}
