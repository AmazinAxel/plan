self: { config, lib, pkgs, ... }:

let
  cfg = config.services.plan;
in {
  options.services.plan = {
    enable = lib.mkEnableOption "Plan";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port on 127.0.0.1. Not opened in the firewall; reached through `tailscale serve`.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/plan";
      description = "Holds plan.db (data, images, backups). Waits for its mount if it is on one.";
    };

    tailscaleServe = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Publish the app at https://<host>.<tailnet>.ts.net via `tailscale serve`
        (tailnet only, real certificate). Needs MagicDNS and HTTPS certificates
        enabled in the Tailscale admin console.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.plan = { isSystemUser = true; group = "plan"; };
    users.groups.plan = { };

    systemd.services.plan = {
      description = "Plan";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      unitConfig.RequiresMountsFor = cfg.dataDir;
      environment = {
        PORT = toString cfg.port;
        HOST = "127.0.0.1";
        PLAN_DATA_DIR = cfg.dataDir;
        BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"; # no writable home to cache into
      };
      serviceConfig = {
        # `+` runs as root: creates the dir on a fresh drive and fixes ownership
        # of a hand-copied plan.db.
        ExecStartPre = [
          "+${pkgs.coreutils}/bin/install -d -m 0750 -o plan -g plan ${cfg.dataDir}"
          "+${pkgs.coreutils}/bin/chown -R plan:plan ${cfg.dataDir}"
        ];
        ExecStart = lib.getExe cfg.package;
        User = "plan";
        Group = "plan";
        Restart = "always";
        RestartSec = 5;
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.dataDir ];
        ProtectHome = true;
        PrivateTmp = true;
      };
    };

    # tailscaled keeps the serve config in its own state, so this only has to
    # (re)assert it. Retries until tailscale is up and logged in. The timeout
    # matters: with HTTPS not yet enabled for the tailnet, `serve` waits
    # indefinitely, and a oneshot has no start timeout by default, so boot and
    # switch would hang on it.
    systemd.services.plan-tailscale-serve = lib.mkIf cfg.tailscaleServe {
      description = "Publish Plan on the tailnet";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" "plan.service" ];
      wants = [ "tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = 15;
        TimeoutStartSec = 30;
        ExecStart = "${lib.getExe config.services.tailscale.package} serve --bg --https=443 http://127.0.0.1:${toString cfg.port}";
      };
    };
  };
}
