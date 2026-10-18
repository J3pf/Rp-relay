# Release Notes — Rp-relay v0.5.3

## Highlights

### Human-Friendly Agent Display Names (Agent Mesh UX)
In previous versions, unnamed Pi sessions or auto-generated session IDs would fall back directly to raw UUIDs (e.g., `01a14fbb-2812-7332-aae5-d003f17b8fe7`) in node names, communication endpoints, and group chip labels on the Android app's "Red de agentes" screen.

With v0.5.3:
- **`agentDisplayName(agent)` Pure Helper:** Unified resolution logic across topology nodes, group labels, comms views (`fromName`/`toName`), and prompt summaries.
- **Precedence:**
  1. Human `session_name`: Non-human identifiers (UUIDs, ULIDs, hex IDs of length ≥ 8, and automated prefixes like `subagent-chat-<hex>`) are strictly rejected.
  2. Directory basename `basename(cwd)`.
  3. Default fallback `"Agent"`.
  4. Raw IDs and UUIDs are **never** returned.
- **Deterministic Duplicate Disambiguation:** When multiple agents on the same machine share the same base display name within a snapshot, they are disambiguated deterministically (`"Rp-app"`, `"Rp-app (2)"`, `"Rp-app (3)"`) ordered stably by `first_seen_at` ascending and tie-broken by `agentId`. Agents on distinct machines stay unsuffixed.
- **Clean Group Labels:** Group chip labels resolve to the orchestrator's display name or the common directory basename of member agents, never falling back to a raw UUID or session ID.
- **Wire Contract Preservation:** Wire contracts and protocol schemas remain 100% backward-compatible.
