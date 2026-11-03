{
  description = "Source-built Xodus Nexus launcher for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f (import nixpkgs { inherit system; }));
    in {
      packages = forAllSystems (pkgs:
        let nexusRuntime = pkgs.callPackage ./nix/runtime.nix { };
        in {
          nexus-runtime = nexusRuntime;
          default = pkgs.callPackage ./nix/package.nix {
            src = self;
            inherit nexusRuntime;
          };
        });
      apps = forAllSystems (pkgs:
        let
          launcher = {
            type = "app";
            program = "${pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default}";
          };
        in {
          default = launcher;
          xodus-nexus = launcher;
        });
      checks = forAllSystems (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });
    };
}
