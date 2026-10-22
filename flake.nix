{
  description = "Plan: keyboard-driven planning board, self-hosted on Bun + SQLite";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      forAll = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ]
        (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAll (pkgs: { default = pkgs.callPackage ./nix/package.nix { }; });
      nixosModules.default = import ./nix/module.nix self;
      devShells = forAll (pkgs: { default = pkgs.mkShell { packages = [ pkgs.bun pkgs.sqlite ]; }; });
    };
}
