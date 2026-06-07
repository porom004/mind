# Mind Memory Protocol

This tool contains all the context you need to use mind effectively.
After this, you can proceed with space_create, memory_add, etc.

---

## Space Naming Convention

**For software projects, use the directory/repo name as the space name.**

Use actual project names so future agents can search and recover the right knowledge.

### Recommended:

- `projects/mind` — actual repo name
- `projects/arcana-web` — actual repo name
- `projects/api-gateway` — actual directory name

**Why**: Future agents search by repo/directory name. Using the actual name makes your memories discoverable.

---

## Before Adding Memories

You MUST create a space with `space_create` before adding memories. Memory tools fail with "Space X does not exist" if the space hasn't been created.

---

## Tag Conventions

**Custom tags are allowed.** The following are RECOMMENDED:

### Space tags:

- `type:project` — code project spaces
- `type:user` — user preferences/settings
- `type:session` — session summaries
- `type:config` — cross-project configuration
- `type:learning` — learned knowledge

### Memory tags:

- `cat:decision` — architectural decision
- `cat:bugfix` — bug fix
- `cat:pattern` — established convention
- `cat:discovery` — technical finding
- `cat:preference` — user preference
- `cat:config` — configuration
- `cat:summary` — session summary (with type:session)

### Status tags:

`status:*` tags are convention-only, not schema-enforced. Use well-normed tags
such as `status:proposed`, `status:validated`, `status:failed`,
`status:superseded`, `status:obsolete`, `status:final`, and `status:living`.

### Living reference tags:

Living references must use `type:reference`, exactly one `ref:*` tag, and
`status:living`. Recommended refs are `ref:project-map`, `ref:architecture`,
`ref:style`, `ref:domain`, and `ref:workflow`.

Before creating a new tag, query existing memories first: `memory_query { space: "*", search: "<topic>" }`.

---

## Space Structure

Organize memories into hierarchical spaces:

- `projects/<REPO_NAME>` — one space per project (use actual repo/directory name)
- session summaries stay in `projects/<REPO_NAME>` as `session-*` memories tagged `type:session` + `cat:summary` at T3
- `user/preferences` — global user preferences
- `user/patterns` — work patterns and conventions
- `global/config` — cross-project configuration

---

## When to Save Memories

### Durable memory threshold

Create or update durable memories when the information is likely useful in
future sessions:

- Stable decisions
- Verified root causes
- Final fixes
- Reusable patterns
- User preferences
- Significant config/domain facts

Keep transient observations, routine progress, and routine validation results with no new findings in checkpoints or session summaries.

Durable memories are separate from session summaries. Use durable memories when
future sessions need stable decisions, root causes, patterns, preferences,
config, or domain facts.

Use `memory_add` after:

- Durable bug fix completed
- Architecture or workflow decision made
- Non-obvious technical discovery
- Configuration or environment change
- Pattern established
- User preference learned

**When to link**: When a new memory depends on, updates, or explains another memory, pass related memories in `links_to`. After adding with `links_to`, check `links_created` and `links_failed`; retry important failed links with `link_create`.

Persist verified root causes, regressions, risk decisions, or durable validation
patterns. Don't persist routine validation outcomes unless they change future
work.

---

## Memory Types

- Checkpoint = live/ephemeral work state. Keep goal, pending work, blockers,
  and next action here.
- Session summary = chronological log/recovery record. It preserves what
  happened, but it is evidence, not canonical truth.
- Durable/canonical memory = atomic actionable knowledge for future sessions.
- Living reference memory = maintained current truth map for a project, domain,
  architecture, style, or workflow.

| Need                                                                          | Use                                                | Result                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Live goal, pending work, blockers, or next action                             | `checkpoint_save`                                  | Active checkpoint                    |
| End-of-session recovery log                                                   | `checkpoint_done`                                  | Same-space `session-*` summary at T3 |
| Stable decisions, root causes, patterns, preferences, config, or domain facts | `memory_add` / `memory_update`                     | Durable memory                       |
| Compact current truth map                                                     | `memory_add` / `memory_update` with reference tags | Living reference                     |
| Obsolete knowledge with no historical value                                   | `memory_delete`                                    | Removed memory                       |

---

## Living Reference Memories

Living references are compact current truth. Create them at T2 by default; let
reads naturally promote them to T1. Pin only 1–3 critical references when
explicitly warranted or approved.

Tags are authoritative. Required tags: `type:reference`, exactly one `ref:*`, and `status:living`.
Recommended refs are `ref:project-map`, `ref:architecture`, `ref:style`,
`ref:domain`, and `ref:workflow`. The `ref:*` tag defines the reference category; the memory name is the readable identifier.

Recommended names: `architecture-overview`, `project-map`, `style-guide`, `domain-model`, and `workflow-notes`.

Recommended name examples:

- `architecture-overview`
- `project-map`
- `style-guide`
- `domain-model`
- `workflow-notes`

Recommended sections:

- Purpose
- Current truth
- Key areas/files/concepts
- Active conventions
- Source memories
- Last reviewed
- Maintenance notes

When current truth changes, use `memory_update` on the living reference and
link it to source memories. Sessions remain evidence/logs, not canonical truth.

---

## Cautious Deletion

Use `memory_delete` only when a memory is clearly obsolete, no longer
applicable, and has no historical value. Otherwise, mark it with
`status:obsolete` or `status:superseded` and link the replacement.

---

## Memory Content Format

Use this format:

**What**: One sentence — what was done
**Why**: What motivated it
**Where**: Files or paths affected
**Learned**: Gotchas or edge cases (omit if none)

Example:

```
**What**: Switched from sessions to JWT for authentication
**Why**: Session storage doesn't scale across multiple server instances
**Where**: src/middleware/auth.ts, src/routes/login.ts
**Learned**: Must set httpOnly and secure flags on cookies
```

---

## Tier System

| Tier | Name | Use Case                   | Limit/space |
| ---- | ---- | -------------------------- | ----------- |
| T1   | hot  | Critical active info       | 25          |
| T2   | warm | Default for new memories   | 50          |
| T3   | cold | Reference info (unlimited) | unlimited   |

**Behaviors:**

- **Auto-promote**: `memory_read` moves memory up one tier (T3→T2→T1)
- **Pin**: Set `pinned: true` to make a memory immune to promotion and eviction
- **LRU eviction**: When a tier is full, least-recently-used non-pinned memory moves down one tier

---

## Tool Quick Reference

| Category   | Tools                                                               |
| ---------- | ------------------------------------------------------------------- |
| Spaces     | space_create, space_list, space_get, space_update, space_delete     |
| Memories   | memory_add, memory_update, memory_delete, memory_read               |
| Links      | link_create, link_delete                                            |
| Query      | memory_query (use `search` parameter for full-text search)          |
| Checkpoint | checkpoint_save, checkpoint_done, checkpoint_load, checkpoint_query |

**Note**: `search` tool has been removed — use `memory_query { search: "..." }` instead.

---

## Pagination

For list tools (`memory_query`):

- `limit`: Number of results (default 25, max 500)
- `offset`: Zero-based index
- Response includes `pagination.nextOffset` when more results exist

---

## Session Workflow

1. **Start**: `checkpoint_query` to find checkpoints, then `checkpoint_load { checkpointName: "<name>" }` to restore a specific one, then `space_get` (use repo name)
2. **Work**: Add memories as you go with `memory_add` — include tags and `links_to`
3. **Query**: Find context with `memory_query { search: "<keywords>" }`
4. **Checkpoint**: Save progress with `checkpoint_save`
5. **Close**: Checkpoints hold live state; `checkpoint_done` completes the active checkpoint and creates a same-space `session-*` summary memory in `projects/<REPO_NAME>` with `type:session` + `cat:summary` at T3.

---

## Example Workflow

```javascript
// 1. Create a project space (use repo name!)
space_create {
  name: "projects/mind",
  description: "Mind project decisions and patterns",
  tags: ["type:project"]
}

// 2. Add a decision memory
memory_add {
  space: "projects/mind",
  name: "JWT over sessions for auth",
  content: "**What**: Switched from sessions to JWT...\n**Why**: Scale across instances...",
  tags: ["cat:decision"]
}

// 3. Add a related discovery with link
memory_add {
  space: "projects/mind",
  name: "Refresh token rotation needed",
  content: "**What**: JWT requires refresh token rotation...",
  tags: ["cat:discovery"],
  links_to: ["JWT over sessions for auth"]  // bare name, same space
}

// 4. Query decisions
memory_query { space: "projects/mind", tag: "cat:decision" }

// 5. Search memories
memory_query { space: "projects/mind", search: "authentication" }

// 6. Session end: close the checkpoint
checkpoint_done {
  space: "projects/mind",
  checkpointName: "checkpoint-2026-03-07T10-00-00-000Z",
  summary: "## Goal: ...\n## Accomplished: ...\n## Decisions: ..."
}
```

---

## Common Errors

- "Space X does not exist": Create the space first with `space_create`
- "Memory with id X does not exist": Use `memory_query` to get valid IDs
- "T1 is full": Unpin some memories or let the system auto-evict
