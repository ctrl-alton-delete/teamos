# TeamOS

TeamOS is a virtual workplace system that orchestrates AI and human team members through structured work cycles. Each AI member gets a small *cycle* at a time to perform a unit of work, respond to messages, advance projects, and collaborate with other members.

TeamOS lives as its own repository and integrates into any project, giving every repo the same team orchestration without duplicating code.

## How It Works

Team members are defined in a `team/` workspace directory within the host project. Each member has a profile, current state, todo list, schedule, and inbox. A runner script processes members through priority-cascading cycles, invoking an AI agent (Claude, Cursor, Augment) for each.

The runner provides full context — organization docs, news, projects, and the member's own files — then commits after each member completes. A clerk agent runs after each pass for cleanup (archiving old news, removing stale schedule items, etc.).

### Package Structure

```
teamos/
├── README.md                # This file — system architecture reference
├── scripts/
│   ├── run.mjs              # Runner — orchestrates member cycles
│   ├── init.mjs             # Project initialization
│   └── detach.mjs           # Package removal
├── agent-rules/
│   ├── cycle.md             # Rules for member cycle agents
│   ├── clerk.md             # Rules for clerk agent
│   ├── self-assessment.md   # Rules for weekly self-assessment
│   └── root.md              # Section appended to host AGENTS.md
├── templates/
│   ├── *.d.ts               # TypeScript type definitions
│   └── *-template.*         # File templates for new members
└── ui/                      # Web dashboard (Svelte + Vite)
    ├── package.json
    ├── vite.config.ts
    └── src/
```

### Workspace Structure

```
team/
├── org.md               # Organization description
├── members.json         # Member manifest
├── projects.json        # Goals and projects
├── memos.json           # Timely information for all members
├── members/
│   └── [memberName]/
│       ├── profile.md   # Member description
│       ├── state.md     # Current state of work
│       ├── todo.json    # Task list
│       ├── schedule.json
│       ├── inbox/       # Messages from other members
│       └── archives/
├── data/                # Shared data artifacts
├── docs/                # Shared documentation
├── archives/            # Archived org-level items
└── .logs/               # Agent execution logs (git-ignored)
```

## Quick Start

### 1. Install teamos into your project

```bash
# Git submodule (recommended):
git submodule add <teamos-repo-url> teamos
node teamos/scripts/init.mjs

# Git subtree (works with git worktrees; submodules do not):
git subtree add --prefix=teamos <teamos-repo-url> main --squash
node teamos/scripts/init.mjs

# Symlink (teamos cloned elsewhere):
node /path/to/teamos/scripts/init.mjs
```

This creates the `team/` workspace with directories, empty manifests, and agent-rule references.

### 2. Add a team member

Create a member directory with a profile:

```bash
mkdir -p team/members/alice/inbox
```

`team/members/alice/profile.md`:
```markdown
---
name: alice
title: Software Engineer
roles: [developer]
active: true
type: ai
personality:
  openness: 8
  conscientiousness: 9
  extraversion: 5
  agreeableness: 7
  neuroticism: 3
---
Alice is a detail-oriented software engineer focused on backend systems.
```

Add her to `team/members.json`:
```json
{
  "members": [
    {
      "name": "alice",
      "title": "Software Engineer",
      "roles": ["developer"],
      "active": true,
      "type": "ai"
    }
  ]
}
```

Create her initial files:
```bash
cp teamos/templates/todo-template.json team/members/alice/todo.json
cp teamos/templates/schedule-template.json team/members/alice/schedule.json
cp teamos/templates/state-template.md team/members/alice/state.md
```

### 3. Run cycles

```bash
# See who has work
node teamos/scripts/run.mjs --dry-run

# Run cycles for all members
node teamos/scripts/run.mjs

# Run only a specific member
node teamos/scripts/run.mjs --member alice

# Use a different agent
node teamos/scripts/run.mjs --agent cursor

# Don't auto-commit and keep looping
node teamos/scripts/run.mjs --loop --no-commit
```

### Runner Options

| Option | Default | Description |
|---|---|---|
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, or `auggie` |
| `--priority <level>` | `pressing` | Starting priority level |
| `--member <name>` | — | Only run cycles for a specific member |
| `--max-cycles <n>` | `10` | Maximum cycle passes per scheduling pass |
| `--loop` | — | Enable continuous scheduling loop |
| `--interval <min>` | `120` | Minutes between passes (implies `--loop`) |
| `--push` | — | Push to remote after each commit |
| `--no-commit` | — | Skip automatic git commit after each cycle |
| `--no-clerk` | — | Skip clerk agent after each pass |
| `--clerk-only` | — | Run only the clerk agent, then exit |
| `--budget <pri:n>` | `thisWeek:2, later:1` | Max member cycles at a priority per pass (repeatable) |
| `--dry-run` | — | List members with work, don't invoke agent |

### Loop Mode (Built-in Scheduler)

Instead of running via an external cron job, the runner can operate as a long-lived process with its own scheduling loop:

```bash
# Default: 2-hour interval
node teamos/scripts/run.mjs --loop

# Custom interval (90 minutes)
node teamos/scripts/run.mjs --interval 90

# With a specific agent
node teamos/scripts/run.mjs --loop --agent cursor
```

In loop mode the runner:

1. Runs a full priority cascade pass (no hard time limit)
2. If the pass completes before the interval elapses, **idles** — polling every 30 seconds for new work or a `.stop` file
3. If new work arrives during idle at **pressing** or **today** priority, starts the next pass early. Lower-priority work (thisWeek, later) waits for the interval timer.
4. If the pass overruns the interval, starts the next pass immediately

**Cycle budgets** — Lower-priority work is nibbled at rather than fully processed each pass. Per-pass limits prevent the runner from being perpetually busy with non-urgent work:

| Priority | Default budget | Effect |
|---|---|---|
| `pressing` | unlimited | Always fully processed |
| `today` | unlimited | Always fully processed |
| `thisWeek` | 2 member cycles | At most 2 members run per pass |
| `later` | 1 member cycle | At most 1 member runs per pass |

Override with `--budget <priority>:<count>` (repeatable). Starvation cycles bypass budgets.

**Member ordering** — At unbounded priorities (pressing, today), members run in `members.json` order every pass. Place operationally critical roles (e.g. DevOps) earlier in the manifest so their urgent work is always handled first. At budgeted priorities (thisWeek, later), members are served in **round-robin** order so that no single member monopolizes the limited slots. The rotation state is persisted in `scheduler-state.json` across restarts.

**Starvation prevention** — If high-priority work dominates every pass, lower priorities get periodic forced cycles so they don't drift indefinitely:

| Priority | Guaranteed cycle every |
|---|---|
| `pressing` | Always (cascade default) |
| `today` | ~24 hours |
| `thisWeek` | ~4 days |
| `later` | ~1 week |

Starvation state is persisted to `team/.logs/scheduler-state.json` so that interruptions and restarts don't reset the clocks. On startup the runner restores the last-served timestamps; if the file is missing or corrupted it falls back to "just now" for all priorities.

Without `--loop`, the runner behaves as before: a single pass with a 1-hour hard time limit.

### Stopping the Runner

Create a `team/.stop` file to gracefully halt the runner between members:

```bash
touch team/.stop
```

The runner checks for this file before each cycle, between each member, and during idle waits. When found, it commits any completed work, removes the stop file, and exits. In loop mode, this exits the outer loop as well.

### Weekly Self-Assessment

The runner automatically ensures every active AI member has a recurring **Weekly Self-Assessment** schedule event (Fridays at 18:00 UTC). On startup, if a member's `schedule.json` lacks this event, the runner injects it.

When the event fires, the member follows the rules in `teamos/agent-rules/self-assessment.md` to produce a reflective evaluation covering:

- **Role fulfillment** — delivering on the job description
- **Strategic vs tactical balance** — big-picture and day-to-day
- **Cycle efficiency** — right-sized work, no wasted context
- **Tool & document effectiveness** — building, maintaining, and reusing
- **State/task/schedule hygiene** — keeping files concise and current
- **Communication quality** — clear, actionable, appropriately targeted
- **Project impact** — meaningful progress toward team goals

Assessments are saved to `team/members/<name>/archives/self-assessments/assessment-YYYY-MM-DD.md`. After completing the assessment, the member bumps the event's `time` forward by one week to maintain the recurrence.

## Priority Cascade

```
pressing  →  today  →  thisWeek  →  later
```

- **Pressing** — Timely; should be processed within an hour
- **Today** — Should be handled today
- **ThisWeek** — Handle this week
- **Later** — Nibble at when there is time

The runner starts at the highest priority and cascades down. It only advances to the next level when no members have work at the current level. Within a priority level, member order follows `members.json` — so list members in descending operational importance.

## Work Detection

A member is given a cycle when any of these are true:
- They have **inbox messages** (markdown files in their `inbox/` directory)
- They have **todo items** at or above the current priority level
- They have **schedule events** that are due

## Cycle Behavior

During a cycle, the agent:
1. Reviews organization context (org, news, projects)
2. Processes inbox messages (reads and deletes them)
3. Performs one unit of work at the current priority
4. Updates state.md with what was accomplished
5. Maintains todos (completes items, adds new ones)

A unit of work can include:
- Maintaining TODOs or schedule
- Advancing a project by a modest increment
- Building a tool (JS/TS library) for self or team
- Sending messages to other members' inboxes
- Outputting artifacts to `team/data/` or `team/docs/`

## Member Communication

Members communicate by dropping markdown files into each other's `inbox/` directories:

```markdown
---
from: alice
sentAt: 2026-03-13T10:00:00Z
requestResponse: true
projectCode: AUTH
---

The auth module is ready for review.
```

## Acting as a Team Member (Interactive Mode)

If you're an interactive agent (e.g. Cursor, Claude chat) asked to "be" a team member rather than running through the automated runner, read the following files to replicate the context the runner provides:

1. **Cycle rules** — `teamos/agent-rules/cycle.md` (how to execute a cycle)
2. **System architecture** — `teamos/README.md` (this file)
3. **Organization** — `team/org.md`
4. **Memos** — `team/memos.json` (timely info for all members)
5. **Projects** — `team/projects.json`
6. **Team roster** — `team/members.json`
7. **Your profile** — `team/members/<you>/profile.md`
8. **Your state** — `team/members/<you>/state.md`
9. **Your TODOs** — `team/members/<you>/todo.json`
10. **Your schedule** — `team/members/<you>/schedule.json`
11. **Your inbox** — all `.md` files in `team/members/<you>/inbox/`

The runner also passes a header with the current priority level and timestamp. When working interactively, default to priority `pressing` and work down the cascade as described above.

Depending on your interaction, you may update your state, TODOs, and schedule. Do not commit — let the human handle that.

## Design Philosophy

- **Priority-driven** — Pressing work is always handled before less urgent tasks
- **Right-sized cycles** — Each cycle does a modest amount of work to maintain continuity without overrunning context windows
- **Agent-owned changes** — The agent modifies files freely; the runner handles git commits
- **Commit per member** — Clean git history for human review between runs
- **Clerk cleanup** — Automated housekeeping after each pass (archiving, fixing inconsistencies)
- **Zero dependencies** — Uses only Node.js built-in modules

## Web Dashboard

TeamOS includes a web dashboard for viewing team status, member details, inboxes, todos, and sending messages.

### Running the Dashboard

```bash
cd teamos/ui
npm install
npm run dev
```

The dashboard starts on `http://localhost:3003` by default.

### Identity ("Me")

On first launch, the dashboard prompts you to select your identity from the member list. This determines:
- The default **From** field when composing messages
- Visual indicators showing which member is "you" in the team grid and detail views

Your identity is stored in the browser's localStorage and can be changed anytime via the dropdown in the navigation bar.

### Configuration

The dashboard auto-discovers the `team/` directory by resolving `../../` from the `teamos/ui/` directory (which maps to the host project root for all installation modes). Override this by setting the `TEAMOS_PROJECT_ROOT` environment variable:

```bash
TEAMOS_PROJECT_ROOT=/path/to/project npm run dev
```

If a `tickets/` directory exists at the project root (e.g. from a ticket management system like tess), the dashboard displays a ticket pipeline summary. This feature is optional and hidden when no tickets directory is found.

## Removing TeamOS

```bash
node teamos/scripts/detach.mjs
```

This removes teamos-created artifacts (agent rule files, symlinks, gitignore entries) but never touches the `team/` workspace data.
