{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    go
    git
    nodejs_22
    sqlite
    pkg-config
    gnumake
  ];

  shellHook = ''
    export CGO_ENABLED=0
    export DATABASE_PATH=''${DATABASE_PATH:-data/subbot.sqlite}
    export STATIC_DIR=''${STATIC_DIR:-web/dist}

    echo "subbot dev shell"
    echo "  go run ./cmd/server"
    echo "  cd web && npm install && npm run dev"
  '';
}
