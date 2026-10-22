{ lib, stdenvNoCC, bun, makeWrapper }:

# No `bun install`: the server only uses Bun built-ins (Bun.serve, bun:sqlite,
# HTMLRewriter), and build.ts only Bun.build.
stdenvNoCC.mkDerivation {
  pname = "plan";
  version = "0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../public ../src ../build.ts ../server.ts ];
  };

  nativeBuildInputs = [ bun makeWrapper ];

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun build.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/plan $out/bin
    cp -r dist src server.ts $out/share/plan/
    makeWrapper ${lib.getExe bun} $out/bin/plan --add-flags $out/share/plan/server.ts
    runHook postInstall
  '';

  meta.mainProgram = "plan";
}
