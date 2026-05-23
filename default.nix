{
  craneLib,
  inputs,
  pkgs,
  root ? ./.,
}:
pkgs.callPackage ./package.nix {
  inherit
    craneLib
    inputs
    root
    ;
}
