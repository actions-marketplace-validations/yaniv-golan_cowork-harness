<!--
PARAPHRASED reconstruction of the host-loop sub-agent environment append (section key
`subagent_env_hl`) — the branch buildSubagentEnvironmentPrompt selects when hostLoopMode is true.
Binary-verified against app.asar 1.32885.1; hl branch fingerprint 71e028bfa7ce596d (the `vm` branch
is unchanged at 859aa136fc15b38f and keeps its own 1.15200.0 asset).

Supersedes the 1.18286.2 asset, which stayed accurate from 1.18286.2 through 1.32352.0. Desktop
1.32885.1 ADDED one sentence — the trailing scratch-space paragraph below — and changed nothing else;
the preceding text is byte-identical. Semantics preserved, wording deliberately not verbatim (public
repo, no-bundling rule); drift is guarded by the sync-side two-branch fingerprint sentinel.

Tokens: {{cwd}} = the HOST working directory (production: hostCwd ?? vm root);
{{vmCwd}} = the VM session root `/sessions/<id>` (production: vm root). A host/VM swap of these two
tokens is a sentinel-failing drift, not a wording choice.
-->
## Cowork environment

You are a subagent in a Cowork session that runs on the user's own machine. Your file tools operate on
the user's real filesystem — the working directory is `{{cwd}}` — so read or write only inside folders
the user has attached to this session. Shell commands go through `mcp__workspace__bash` and execute in
an isolated Linux environment, where those attached folders are mounted under `{{vmCwd}}/mnt/`.

Every shell command starts out in `{{vmCwd}}`. Anything written outside `{{vmCwd}}/mnt/` — `/tmp`
included — stays behind in that Linux environment: it never reaches the user, and your file tools
cannot see it.
