# Reproducibly regenerate the compacted models.dev pricing snapshot from the
# pinned `models-dev` flake input. The upstream repository ships per-model TOML
# sources rather than a prebuilt catalog, so we run their own `generateCatalog`
# routine (via `nix/models-dev-gen.ts`) with Bun. Its only runtime dependencies
# are `remeda` and `zod` (both zero-dependency packages), which we vendor
# directly from the registry using the integrity hashes pinned in upstream
# `bun.lock`.
#
# The build output is copied into the repository (see `just gen-models-dev-pricing`)
# and embedded at build time, so every platform ships identical pinned data
# without build-time network access.
{
  pkgs,
  modelsDevSrc,
}:
let
  # `fetchurl` accepts npm integrity strings verbatim because they already are
  # Subresource Integrity (SRI) hashes. Keep these in sync with the matching
  # entries in `${modelsDevSrc}/bun.lock` whenever the input is bumped.
  remeda = pkgs.fetchurl {
    url = "https://registry.npmjs.org/remeda/-/remeda-2.33.7.tgz";
    hash = "sha512-cXlyjevWx5AcslOUEETG4o8XYi9UkoCXcJmj7XhPFVbla+ITuOBxv6ijBrmbeg+ZhzmDThkNdO+iXKUfrJep1w==";
  };
  zod = pkgs.fetchurl {
    url = "https://registry.npmjs.org/zod/-/zod-3.24.2.tgz";
    hash = "sha512-lY7CDW43ECgW9u1TcT3IoXHflywfVqDYze4waEz812jR/bZ8FHDsl7pFQoSZTz5N+2NqRXs8GBwnAwo3ZNxqhQ==";
  };
in
pkgs.runCommand "models-dev-pricing.json"
  {
    nativeBuildInputs = [ pkgs.bun ];
  }
  ''
    export HOME="$TMPDIR"

    # Copy the read-only source tree into a writable workspace so that Bun can
    # resolve the vendored `node_modules` while importing upstream modules.
    cp -r ${modelsDevSrc} work
    chmod -R u+w work

    # Lay out the two runtime dependencies as a flat node_modules at the
    # workspace root; Bun walks up from each source file to find them.
    mkdir -p work/node_modules/remeda work/node_modules/zod
    tar -xzf ${remeda} -C work/node_modules/remeda --strip-components=1
    tar -xzf ${zod} -C work/node_modules/zod --strip-components=1

    # The generator imports `./packages/core/src/generate.ts`, so it must run
    # from inside the workspace next to the vendored node_modules.
    cp ${./models-dev-gen.ts} work/gen.ts

    cd work
    OUTFILE="$out" bun run gen.ts
  ''
