# Deploying with managed settings

Managed settings are the only layer a local user cannot override. If you want
the enforcement here to be genuinely non-negotiable rather than the path of
least resistance, this is how.

Example file: [managed-settings.example.json](managed-settings.example.json).

## The deployment chain

Order matters, and getting it wrong produces a plugin that looks installed and
enforces nothing.

```
strictKnownMarketplaces   →  only your marketplace can be added at all
extraKnownMarketplaces    →  register it, optionally with autoUpdate
enabledPlugins            →  FORCE-ENABLE this plugin  ← the load-bearing line
allowManagedHooksOnly     →  now block every other source of hooks
```

## The trap

`allowManagedHooksOnly: true` blocks user, project, local **and plugin** hooks.
The single exemption is hooks from plugins **force-enabled in managed
`enabledPlugins`**.

So this configuration disables everything this plugin ships:

```jsonc
{
  "allowManagedHooksOnly": true
  // no enabledPlugins entry → every gate silently dead
}
```

and this one keeps it:

```jsonc
{
  "allowManagedHooksOnly": true,
  "enabledPlugins": { "ai-native-sdlc@sdlc-playbook": true }
}
```

Nothing in the first case reports an error. The plugin installs, the skills
work, the status line appears — and no hook ever fires. `/ai-native-sdlc:sdlc-doctor
--selftest` is what catches it, because it tests firing rather than
configuration.

If `allowManagedHooksOnly` is already true in your environment, the enterprise
step has to move to the **front** of your rollout rather than the end.

## Pinning configuration organisation-wide

`pluginConfigs` in managed settings beats the user's own answers, so the
enforcement level and the approval route can be set centrally:

```jsonc
"pluginConfigs": {
  "ai-native-sdlc@sdlc-playbook": {
    "options": {
      "enforcement_level": "standard",
      "hard_hooks_locked": true,
      "release_approval_route": "the release manager in #release-approvals"
    }
  }
}
```

A team can then still run *stricter* locally — the personal config layer is
tighten-only — but cannot run looser.

## Windows

OS-level sandboxing is **unsupported on native Windows**. Setting
`sandbox.failIfUnavailable: true` would stop Claude Code starting for every
Windows engineer, so the example leaves it `false`.

The consequence is worth stating to whoever signs off on this: on Windows, this
plugin's hooks are the *only* enforcement layer. That is precisely why its
safety-critical gates fail **closed** on internal error — with no sandbox
beneath them, allowing on error would leave no second line at all.

For a fleet that is entirely macOS, Linux or WSL2, turn it on.

## What this still does not give you

Managed settings stop a *local user* from disabling the gates. They do not make
the gates omniscient:

- The command gates are recognisers. They do not see through `base64`, `eval` or
  a script file.
- The production gate verifies that an authorization is present and
  well-formed, not that it is genuine. For a real guarantee the deploy
  credential belongs in CI or behind an environment-scoped MCP tool.
- Server-side branch protection remains the authoritative control for merges.
  Verify it exists rather than assuming — `/ai-native-sdlc:sdlc-doctor` asks the
  forge directly.

Keep [escape-hatches.md](escape-hatches.md) next to whatever you tell your
auditor.
