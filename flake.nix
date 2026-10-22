{
  description = "Plan: keyboard-driven planning board on Bun + SQLite";

  # No inputs: the overlay builds with the host's own nixpkgs. Provides
  # `pkgs.plan`; run `${pkgs.plan}/server.js` with bun, or import it from
  # another bun process (it starts its own listener on 127.0.0.1:8787).
  outputs = { self }: {
    overlays.default = final: prev: {
      # Client minified into dist/, server bundled into one file, so the host
      # never transpiles anything at startup.
      plan = final.stdenvNoCC.mkDerivation {
        name = "plan";
        src = final.lib.fileset.toSource {
          root = ./.;
          fileset = final.lib.fileset.unions [ ./public ./src ./build.ts ./server.ts ];
        };
        nativeBuildInputs = [ final.bun ];
        buildPhase = ''
          export HOME=$TMPDIR
          bun build.ts
          bun build server.ts --target=bun --minify --outfile=server.js
        '';
        installPhase = "mkdir $out && cp -r dist server.js $out/";
      };
    };
  };
}
