{ inputs, lib, ... }:
{
  perSystem =
    { system, ... }:
    let
      pkgs = import inputs.nixpkgs { inherit system; };
      agentLib = inputs.agent-skills.lib.agent-skills;
      localSkills = inputs.nix-filter {
        root = inputs.self;
        include = [ ".agents/skills" ];
      };
      sources = {
        local = {
          path = localSkills;
          subdir = ".agents/skills";
        };
      };
      catalog = agentLib.discoverCatalog sources;
      allowlist = agentLib.allowlistFor {
        inherit catalog sources;
        enableAll = true;
      };
      selection = agentLib.selectSkills {
        inherit catalog sources allowlist;
        skills = { };
      };
      bundle = agentLib.mkBundle {
        inherit pkgs selection;
        name = "ccusage-agent-skills-bundle";
      };
      localTargets = {
        claude = agentLib.defaultLocalTargets.claude // {
          enable = true;
          structure = "copy-tree";
        };
      };
      installLocal = agentLib.mkLocalInstallScript {
        inherit pkgs bundle;
        targets = localTargets;
      };
      syncAgentSkills = pkgs.writeShellApplication {
        name = "sync-agent-skills";
        runtimeInputs = [ installLocal ];
        text = ''
          exec skills-install-local "$@"
        '';
      };
    in
    {
      packages = {
        agent-skills-bundle = bundle;
        inherit syncAgentSkills;
      };
      apps.sync-agent-skills = {
        type = "app";
        program = lib.getExe syncAgentSkills;
      };
      checks.agent-skills = bundle;
    };
}
