# AI Workflow Rules

## Approach

Build this project incrementally using a spec-driven workflow. The three context files (`project-overview.md`,`progress-tracker.md`, `ai-workflow-rules.md`) define what to build, how to build it, and the current state of progress. Always implement against these specs. Do not infer or invent behavior not described in them. When resuming a session, read `progress-tracker.md` first — it is the single source of truth for where the project currently stands.

## Scoping Rules

- Work on one feature unit at a time
- Prefer small, verifiable increments over large speculative changes
- Do not combine unrelated system boundaries in a single implementation step


## Handling Missing Requirements

- Do not invent product behavior not defined in the context files
- If a requirement is ambiguous, state the ambiguity explicitly and propose a resolution before writing any code
- If a requirement is missing entirely, add it as an Open Question in `progress-tracker.md` before continuing

## Keeping Docs in Sync

Update the relevant context file whenever implementation changes affect:

- Feature scope, success criteria → `project-overview.md`
- Always update `progress-tracker.md` after every meaningful implementation step: move items from "In Progress" to "Completed", update "Next Up", add new Open Questions if they arise

## Before Moving to the Next Feature Unit

1. The current unit works end to end — server runs, page renders, interaction works as specified
2. `progress-tracker.md` reflects the completed work accurately
3. If any new Open Question was discovered during implementation, it is recorded in `progress-tracker.md` before moving on

## Resuming a Session

When starting a new conversation about this project:

1. Read `progress-tracker.md` → Current Goal, In Progress, and Session Notes
2. Then ask: "What do you want to work on?" or continue from "In Progress" if clear
3. Do not assume what was built in a previous session is correct — verify against the specs

## Questions to Always Ask Before Writing Code

- Is this behavior defined in the context files?
