{
  fetchPnpmDeps,
  lib,
  makeWrapper,
  nodejs,
  pnpmConfigHook,
  pnpm_11,
  root,
  stdenvNoCC,
}:
let
  pnpm = pnpm_11.override { inherit nodejs; };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "publint";
  version = "0.3.12";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + /package.json)
      (root + /pnpm-lock.yaml)
      (root + /pnpm-workspace.yaml)
      (root + /apps/ccusage/package.json)
      (root + /packages/ccusage-darwin-arm64/package.json)
      (root + /packages/ccusage-darwin-x64/package.json)
      (root + /packages/ccusage-linux-arm64/package.json)
      (root + /packages/ccusage-linux-x64/package.json)
      (root + /packages/ccusage-win32-arm64/package.json)
      (root + /packages/ccusage-win32-x64/package.json)
    ];
  };

  nativeBuildInputs = [
    makeWrapper
    nodejs
    pnpm
    pnpmConfigHook
  ];

  pnpmWorkspaces = [ "ccusage" ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 3;
    hash = "sha256-r6s/mGQc/0HI5YYkkDX/dwlwIb00F9HibJpr+AOUq/8=";
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    toolRoot="$out/lib/publint"
    mkdir -p "$toolRoot/apps" "$out/bin"
    cp -R node_modules "$toolRoot/node_modules"
    cp -R apps/ccusage "$toolRoot/apps/ccusage"
    cp -R packages "$toolRoot/packages"
    makeWrapper "$toolRoot/apps/ccusage/node_modules/.bin/publint" "$out/bin/publint"

    runHook postInstall
  '';

  meta = {
    description = "Publint from the ccusage pnpm lockfile";
    homepage = "https://publint.dev";
    license = lib.licenses.mit;
    mainProgram = "publint";
    platforms = lib.platforms.all;
  };
})
