import { describe, it, expect } from "vitest";
import {
  bashReferenceAccessPaths,
  referenceAccessesOf,
  noteReferenceAccess,
  unionReferenceAccesses,
  type ReferenceChannel,
} from "../src/run/run";

// The DERIVATION behind `RunResult.referencesAccessed`. The field existed to fix a headline that read a
// one-channel count as a statement about reading; the risk it introduces is the mirror image — claiming
// access from a command that merely NAMES a path. Both directions are pinned here.

const PLUGIN = "/sessions/s1/mnt/.local-plugins/acme/references/env.md";
const PLUGIN_SCRIPT = "/sessions/s1/mnt/.remote-plugins/acme/scripts/run.py";

describe("bashReferenceAccessPaths — positives", () => {
  it("captures a plain read of a plugin-rooted reference", () => {
    expect(bashReferenceAccessPaths(`cat ${PLUGIN}`)).toEqual(["references/env.md"]);
  });

  it("captures it inside a pipeline, a quoted argument, and an input redirect", () => {
    expect(bashReferenceAccessPaths(`head -50 "${PLUGIN}" | grep -i tier`)).toEqual(["references/env.md"]);
    expect(bashReferenceAccessPaths(`wc -l < ${PLUGIN}`)).toEqual(["references/env.md"]);
    expect(bashReferenceAccessPaths(`sed -n '1,20p' ${PLUGIN_SCRIPT}`)).toEqual(["scripts/run.py"]);
  });

  it("dedupes one path named twice in one command", () => {
    expect(bashReferenceAccessPaths(`diff ${PLUGIN} ${PLUGIN}`)).toEqual(["references/env.md"]);
  });
});

describe("bashReferenceAccessPaths — the false positives it must NOT produce", () => {
  it("ignores a command that only NAMES the path — an existence check is not a read", () => {
    // The largest false-positive class, and the one that turns `reference_read` into "was the path
    // mentioned". `ls`/`test -f`/`stat` is how an agent asks whether a reference EXISTS, which is the
    // opposite of having read it — and it feeds the critique evaluator, which treats "the agent says it
    // never found X but the record shows it reached X" as confabulation.
    for (const c of [`ls -la ${PLUGIN}`, `test -f ${PLUGIN} && echo yes`, `stat ${PLUGIN}`, `echo ${PLUGIN}`, `basename ${PLUGIN}`])
      expect(bashReferenceAccessPaths(c), c).toEqual([]);
  });

  it("excludes EVERY argument of a write verb, not just the adjacent one", () => {
    // Deciding from `tokens[i-1]` alone let any flag or second argument through: `rm -f <ref>` and
    // `rm A <ref>` both recorded a deleted file as accessed.
    for (const c of [`rm -f ${PLUGIN}`, `rm -rf ${PLUGIN}`, `rm /tmp/a ${PLUGIN}`, `chmod +x ${PLUGIN_SCRIPT}`, `echo x | tee ${PLUGIN}`])
      expect(bashReferenceAccessPaths(c), c).toEqual([]);
  });

  it("finds the real verb behind a wrapper or an earlier segment", () => {
    // `COPY_VERBS` keyed on `tokens[0]` was defeated by every prefix and every chain — and agents chain
    // with `&&` and prefix with `sudo` constantly.
    for (const c of [
      `sudo cp /tmp/x ${PLUGIN}`,
      `env X=1 cp /tmp/x ${PLUGIN}`,
      `mkdir -p /tmp/o && cp /tmp/n ${PLUGIN}`,
      `cp -t ${PLUGIN} /tmp/x`,
    ])
      expect(bashReferenceAccessPaths(c), c).toEqual([]);
  });

  it("scopes the redirect check to its own segment, so a read is not cancelled by a later write", () => {
    // The redirect test searched the WHOLE command, so one path that is both read and written lost the
    // read — a miss, i.e. a false green on `no_observed_reference_access`.
    expect(bashReferenceAccessPaths(`cat ${PLUGIN} && echo done >> ${PLUGIN}`)).toEqual(["references/env.md"]);
  });

  it("ignores a token that walks OUT of the plugin with `..`", () => {
    // The predicate only requires `.local-plugins/` to appear somewhere in the token, so a raw shell
    // token could publish a customer-project filename under a field claiming skill content. The Read
    // channel is safe (its `file_path` arrives resolved); this guard is for the raw-token channel.
    expect(bashReferenceAccessPaths(`cat /x/.local-plugins/acme/references/../../../Acme-Corp/secret.md`)).toEqual([]);
  });

  it("ignores a `references/`/`scripts/` path that is NOT rooted in a mounted plugin", () => {
    // `scripts/` is the commonest directory name there is. Without the plugin-root anchor the agent's own
    // repo build step becomes a "skill script access" — and a customer-project filename gets published
    // into result.json under a field claiming it is skill content.
    expect(bashReferenceAccessPaths("node scripts/build.js")).toEqual([]);
    expect(bashReferenceAccessPaths("cat /Users/someone/acme-client/references/pricing.md")).toEqual([]);
  });

  it("ignores a file the command CREATED or DESTROYED rather than read", () => {
    expect(bashReferenceAccessPaths(`rm ${PLUGIN}`)).toEqual([]);
    expect(bashReferenceAccessPaths(`mv ${PLUGIN} /tmp/x`)).toEqual([]); // a rename reads no bytes
    expect(bashReferenceAccessPaths(`touch ${PLUGIN_SCRIPT}`)).toEqual([]);
    expect(bashReferenceAccessPaths(`echo hi > ${PLUGIN}`)).toEqual([]);
    expect(bashReferenceAccessPaths(`cat <<'EOF' >> ${PLUGIN}\nbody\nEOF`)).toEqual([]);
  });

  it("ignores a COPY DESTINATION but keeps the source — `cp` reads what it copies", () => {
    // Excluding every argument of a `cp` (the way rm/mv are excluded) dropped a real read: the source is
    // opened and its bytes are read. Only the final argument is the destination.
    expect(bashReferenceAccessPaths(`cp ${PLUGIN} /tmp/x`)).toEqual(["references/env.md"]);
    expect(bashReferenceAccessPaths(`cp /tmp/x ${PLUGIN}`)).toEqual([]);
  });
});

describe("bashReferenceAccessPaths — DELIBERATE misses, pinned so a later widening is visible", () => {
  // These are the cost of the plugin-root anchor, and they are why the negative assertion key is named
  // `no_observed_reference_access` rather than promising proof of absence. A change that starts matching
  // any of them must be a conscious one: it re-opens the false-positive class above.
  it("misses a bare relative read after a cd into the skill dir", () => {
    expect(bashReferenceAccessPaths("cd /sessions/s1/mnt/.local-plugins/acme && cat references/env.md")).toEqual([]);
  });

  it("misses a $VAR-built path", () => {
    expect(bashReferenceAccessPaths('cat "$SKILL_DIR/references/env.md"')).toEqual([]);
  });
});

describe("referenceAccessesOf — channel routing", () => {
  it("routes each tool to its own channel via the SAME predicate", () => {
    expect(referenceAccessesOf("Read", { file_path: PLUGIN })).toEqual([{ path: "references/env.md", via: "read" }]);
    expect(referenceAccessesOf("Grep", { path: PLUGIN })).toEqual([{ path: "references/env.md", via: "grep" }]);
    // NO `Glob` channel: its `path` input is a directory by tool contract, so it either fails the
    // predicate outright or records a directory into a field documented as FILES — the same reason
    // `Grep.glob` was dropped. Declaring it advertised coverage that could not exist.
    expect(referenceAccessesOf("Glob", { path: PLUGIN })).toEqual([]);
    expect(referenceAccessesOf("Bash", { command: `cat ${PLUGIN}` })).toEqual([{ path: "references/env.md", via: "bash" }]);
    expect(referenceAccessesOf("mcp__workspace__bash", { command: `cat ${PLUGIN}` })).toEqual([{ path: "references/env.md", via: "bash" }]);
  });

  it("reads Grep's `path`, never its `glob` — a glob is a filename filter, not a path", () => {
    // Declaring a `glob` channel would imply coverage that cannot exist: `references/**/*.md` can never
    // satisfy a predicate requiring a mounted-plugin root.
    expect(referenceAccessesOf("Grep", { pattern: "tier", glob: "references/**/*.md" })).toEqual([]);
  });

  it("returns [] for tools that cannot reach a reference, and for malformed inputs", () => {
    expect(referenceAccessesOf("WebSearch", { query: "references/env.md" })).toEqual([]);
    expect(referenceAccessesOf("Read", undefined)).toEqual([]);
    expect(referenceAccessesOf("Bash", {})).toEqual([]);
  });
});

describe("the `read` projection and the main∪sub union — one fixture, both derivations", () => {
  // Plan item 4: `referencesRead` must be EXACTLY the `read` subset. It is derived at the capture site
  // from the same accesses, and nothing else pinned that — so a future edit could let the narrow field
  // and the wide one disagree about the same run, which is precisely what one-derivation buys.
  it("referencesRead is exactly the read-channel subset of referencesAccessed", () => {
    const accessed: Array<{ path: string; via: ReferenceChannel[] }> = [];
    const filesRead: string[] = [];
    const events = [
      { name: "Read", input: { file_path: PLUGIN } },
      { name: "Bash", input: { command: `cat ${PLUGIN_SCRIPT}` } },
      { name: "Grep", input: { path: PLUGIN_SCRIPT } },
    ];
    for (const ev of events)
      for (const a of referenceAccessesOf(ev.name, ev.input)) {
        noteReferenceAccess(accessed, a.path, a.via);
        if (a.via === "read" && !filesRead.includes(a.path)) filesRead.push(a.path);
      }
    expect(accessed).toEqual([
      { path: "references/env.md", via: ["read"] },
      { path: "scripts/run.py", via: ["bash", "grep"] },
    ]);
    expect(filesRead).toEqual(accessed.filter((e) => e.via.includes("read")).map((e) => e.path));
    // And the narrow field is genuinely narrower here — otherwise this test could not tell them apart.
    expect(filesRead).not.toEqual(accessed.map((e) => e.path));
  });

  it("unionReferenceAccesses merges sub-agent accesses in — a main-agent-only read is a false green", () => {
    // Plan item 5 / the scope contract. A dispatcher-shaped skill does all its reading a level down, so
    // evaluating an assertion against the top-level list alone passes `no_observed_reference_access` on a
    // run where a sub-agent read the file cover to cover.
    expect(
      unionReferenceAccesses({
        referencesAccessed: [{ path: "references/a.md", via: ["read"] }],
        subagents: [
          { referencesAccessed: [{ path: "references/a.md", via: ["bash"] }] },
          { referencesAccessed: [{ path: "scripts/b.py", via: ["read"] }] },
        ],
      }),
    ).toEqual([
      { path: "references/a.md", via: ["read", "bash"] },
      { path: "scripts/b.py", via: ["read"] },
    ]);
  });

  it("returns undefined when the TOP-LEVEL list is absent, even if sub-agents have one", () => {
    // Absence of the top-level field is the cannot-verify signal (no observable drive). A sub-agent list
    // must never upgrade that into a verified answer.
    expect(unionReferenceAccesses({ subagents: [{ referencesAccessed: [{ path: "references/a.md", via: ["read"] }] }] })).toBeUndefined();
    expect(unionReferenceAccesses({})).toBeUndefined();
  });

  it("survives malformed on-disk shapes rather than throwing", () => {
    expect(unionReferenceAccesses({ referencesAccessed: [null, { path: 42 }, { path: "references/a.md" }], subagents: "nope" })).toEqual([
      { path: "references/a.md", via: [] },
    ]);
  });
});

describe("noteReferenceAccess", () => {
  it("merges channels for one path instead of listing it twice", () => {
    const list: Array<{ path: string; via: ReferenceChannel[] }> = [];
    noteReferenceAccess(list, "references/env.md", "bash");
    noteReferenceAccess(list, "references/env.md", "read");
    noteReferenceAccess(list, "references/env.md", "bash");
    expect(list).toEqual([{ path: "references/env.md", via: ["bash", "read"] }]);
  });

  it("keeps first-seen order across paths", () => {
    const list: Array<{ path: string; via: ReferenceChannel[] }> = [];
    noteReferenceAccess(list, "scripts/b.py", "read");
    noteReferenceAccess(list, "references/a.md", "read");
    expect(list.map((e) => e.path)).toEqual(["scripts/b.py", "references/a.md"]);
  });
});
