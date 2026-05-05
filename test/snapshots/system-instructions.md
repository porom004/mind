# Mind Memory Protocol

This tool contains all the context you need to use mind effectively.
After this, you can proceed with space_create, memory_add, etc.

---

## Space Naming Convention

**For software projects, use the directory/repo name as the space name.**

This is VITAL for future agents to find your knowledge. If you use arbitrary names like "my-project" or "test123", future agents won't know where to search.

### DO:

- `projects/mind` — actual repo name
- `projects/arcana-web` — actual repo name
- `projects/api-gateway` — actual directory name

### DON'T:

- `projects/my-awesome-app` — too vague
- `projects/work-stuff` — unclear
- `projects/test123` — meaningless

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

Call `memory_add` IMMEDIATELY after:

- Bug fix completed
- Architecture decision made
- Non-obvious technical discovery
- Configuration or environment change
- Pattern established
- User preference learned

**When to link**: When a memory depends on, extends, or contradicts another. Pass `links_to` with `"space:name"` references. `links_to` is best-effort — always check `links_failed` in the response. The memory is always created even if some links fail.

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
5. **Close**: `checkpoint_done` — transforms the checkpoint into a same-space `session-*` T3 summary in `projects/<REPO_NAME>` and deletes the checkpoint

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

// 6. Session end: summarize
memory_add {
  space: "projects/mind",
  name: "session-2026-03-07",
  content: "## Goal: ...\n## Accomplished: ...\n## Decisions: ...",
  tags: ["type:session", "cat:summary"],
  tier: 3,
  links_to: ["projects/mind:JWT over sessions for auth"]
}
```

---

## Common Errors

- "Space X does not exist": Create the space first with `space_create`
- "Memory with id X does not exist": Use `memory_query` to get valid IDs
- "T1 is full": Unpin some memories or let the system auto-evict
