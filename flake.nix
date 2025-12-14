{
  description = "Usage analysis tool for Claude Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
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
      }
    );
}
