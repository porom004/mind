# Mind Memory Protocol (Claude Code)

Use this protocol when Claude Code is connected to the `mind` MCP server.

## MANDATORY: First Actions

1. `checkpoint_query` — find available checkpoints for the current project space
2. `checkpoint_load { checkpointName: "<name>" }` — recover a specific checkpoint by name
3. `space_get` — check if the project space exists (use repo/directory name: `projects/<repo-name>`)
4. If space doesn't exist: `space_create` with `tags: ["type:project"]`
5. `memory_query { space: "<project>", search: "<current-task-keywords>" }` — find related context

Call `system_instructions` before using memory tools in a new session for full usage details.

## MANDATORY: During Work

After EVERY significant event (decision, bug fix, discovery, config change, user preference):

```
memory_add {
  space: "projects/<repo-name>",
  name: "<descriptive-kebab-name>",
  content: "**What**: ...\n**Why**: ...\n**Where**: ...\n**Learned**: ...",
  tags: ["cat:decision"],
  links_to: ["<space:name of related memory>"]
}
```

- Every memory MUST have at least 1 tag: `cat:decision`, `cat:bugfix`, `cat:discovery`, `cat:pattern`, `cat:preference`, `cat:config`
- Always check for related memories with `memory_query { space: "<project>", search: "<keywords>" }` and pass their names to `links_to`
- `links_to` is best-effort — always check `links_failed` in the response for any links that couldn't be created
- Update checkpoint after completing subtasks: `checkpoint_save`

## MANDATORY: Session End

1. `checkpoint_done { space: "projects/<repo-name>", summary: "..." }`
   → Auto-creates a same-space `session-*` memory in `projects/<repo-name>` with tags `type:session` + `cat:summary`, default tier T3, then deletes the checkpoint
2. (optional) `memory_update` to enrich the session memory if needed

## Checkpoint Aging

If the active checkpoint is **less than 30 minutes old**: continue using it.
If it is **30 minutes or older**: close it with `checkpoint_done` and create a new one with `checkpoint_save`.

## Post-Compaction Recovery

If context resets or compaction happens:

1. `checkpoint_query` to find available checkpoints
2. `checkpoint_load { checkpointName: "<name>" }` to restore a specific checkpoint
3. `memory_query { space: "<project>", search: "<keywords>" }` for recent context
4. Re-establish goal, pending steps, and relevant files before making edits

## You Are Breaking the Rules If

- You did significant work without calling `memory_add`
- You created a memory without tags
- You created a memory related to an existing one without linking it
- Your checkpoint is stale (doesn't reflect current progress)
- You started working without calling `checkpoint_query` + `checkpoint_load` with specific name first
