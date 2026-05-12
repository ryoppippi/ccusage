{
  description = "Usage analysis tool for Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.zig-overlay.url = "github:mitchellh/zig-overlay/0cebd9b9215fa121233f9a0799d2acfbbfaee700";

  outputs = { nixpkgs, zig-overlay, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          let
            pkgs = nixpkgs.legacyPackages.${system};
            zig = zig-overlay.packages.${system}."0.16.0";
          in
          f pkgs zig);
    in {
      devShells = forAllSystems (pkgs: zig: {
        default = pkgs.mkShellNoCC {
          buildInputs = [
            # Package manager
            pkgs.pnpm_10

            # Development tools
            zig
            pkgs.typos
            pkgs.typos-lsp
            pkgs.jq
            pkgs.git
            pkgs.gh
          ];

          shellHook = ''
            # Install dependencies only if node_modules/.pnpm/lock.yaml is older than pnpm-lock.yaml
            if [ ! -f node_modules/.pnpm/lock.yaml ] || [ pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; then
              echo "📦 Installing dependencies..."
              pnpm install --frozen-lockfile
            fi
          '';
        };
      });
    };
}
