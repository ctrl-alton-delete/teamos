# TeamOS OpenCode Runner Integration Plan

## Executive Summary

This plan describes the implementation of OpenCode as a supported runner for TeamOS member cycles, alongside the existing Claude, Auggie, and Cursor adapters.

**Estimated Effort:** 4-6 hours  
**Complexity:** Medium  
**Risk Level:** Low-to-Medium

---

## 1. Background & Context

### Current State
TeamOS (`teamos/scripts/run.mjs`) currently supports three agent runners:
- **Claude** — `claude` CLI with stream-json output
- **Auggie** — `auggie` CLI with instruction file parameter
- **Cursor** — `agent` CLI via shellCmd with stream-json output

Each agent:
1. Receives a markdown instruction file containing the full cycle prompt
2. Outputs stream-json formatted data to stdout
3. Has its output parsed by a `formatStream` function
4. Gets spawned as a subprocess with piped I/O
5. Completes with an exit code (logged for audit)

### Why OpenCode?
OpenCode is an open-source AI coding agent that:
- Has a mature CLI interface (`opencode run`)
- Supports non-interactive mode with JSON output (`--format json`)
- Can read context from the current working directory
- Outputs stream-json format (compatible with TeamOS parsers)
- Provides an alternative to proprietary agents

---

## 2. Architecture & Design Decisions

### 2.1 OpenCode Agent Adapter

**File:** `teamos/scripts/run.mjs` (lines ~197-226)

Add OpenCode to the `agents` object:

```javascript
opencode: (instructionFile) => ({
  cmd: 'opencode',
  args: [
    'run',
    '--format', 'json',
    `Read and follow all instructions in the file: ${instructionFile}`
  ],
  formatStream: formatOpenCodeJsonLine,
}),
```

**Key Design Choices:**
- Use `opencode run` (non-interactive mode) rather than TUI
- Specify `--format json` to get structured output
- Pass instruction file path in the prompt message
- Create a dedicated `formatOpenCodeJsonLine` parser function

### 2.2 Stream Parser Function

**File:** `teamos/scripts/run.mjs` (new, after `formatCursorJsonLine`)

Create `formatOpenCodeJsonLine(line)` to parse OpenCode's stream-json output:

```javascript
function formatOpenCodeJsonLine(line) {
  // Parse OpenCode JSON events
  // Map to { text?, done?, exitCode? } format
  // Handle: user, assistant, tool_call events
  // Return completion signal when done
}
```

**Output Format Compatibility:**
OpenCode's stream-json should match or map to existing format:
- `type: 'user'` → `[USER]\n...`
- `type: 'assistant'` → `[ASSISTANT]\n...`
- `type: 'tool_call'` → `[TOOL]\n...`
- `type: 'result'` → completion signal with exit code

### 2.3 Error Handling & Fallbacks

**Execution Path:**
1. Check if `opencode` command is available (spawn with `stdio: 'ignore'` first)
2. If not found, emit helpful error: "OpenCode not installed. Install with: npm install -g opencode-ai"
3. If auth missing, error: "OpenCode auth required. Run: opencode auth login"
4. If cycle fails, log full output and let clerk handle recovery

**Constraints:**
- OpenCode must be installed globally or in PATH
- OpenCode credentials must be pre-configured
- OpenCode project context requires repo to be initialized (via `opencode /init` or existing `AGENTS.md`)

---

## 3. Implementation Phases

### Phase 1: Research & Validation (1-2 hours)
**Goal:** Confirm OpenCode compatibility and output format

Tasks:
- [ ] Install OpenCode locally
- [ ] Run `opencode run` with a test prompt
- [ ] Capture actual stream-json output format
- [ ] Verify output matches existing parser expectations
- [ ] Test error scenarios (missing auth, no project context)
- [ ] Document exact command-line arguments needed

**Deliverable:** Sample OpenCode JSON output file and notes on format differences

### Phase 2: Adapter Implementation (2-3 hours)
**Goal:** Add OpenCode support to TeamOS runner

Tasks:
- [ ] Add OpenCode to `agents` object in `run.mjs`
- [ ] Implement `formatOpenCodeJsonLine()` parser
- [ ] Add help text for `--agent opencode` option
- [ ] Implement error handling for missing/misconfigured OpenCode
- [ ] Test adapter with dry-run: `node teamos/scripts/run.mjs --agent opencode --dry-run`

**Files to Modify:**
- `teamos/scripts/run.mjs` (lines ~25, ~197-226, ~156-191, ~1126)

**Deliverable:** Working adapter that can spawn OpenCode cycles

### Phase 3: Testing & Validation (2-3 hours)
**Goal:** Ensure OpenCode cycles work end-to-end

Tasks:
- [ ] Create a test team member with simple todos
- [ ] Run a pressing priority cycle: `node teamos/scripts/run.mjs --agent opencode --member test-member`
- [ ] Verify file changes are correct
- [ ] Verify state/todo updates work
- [ ] Verify git commits are created
- [ ] Test inbox message processing
- [ ] Test schedule event handling
- [ ] Test error recovery (clerk runs after failures)
- [ ] Verify logs are captured in `team/.logs/`

**Testing Checklist:**
- [ ] Cycle completes successfully
- [ ] Files are modified as expected
- [ ] Git history is clean (one commit per cycle)
- [ ] No output formatting issues
- [ ] Error messages are clear and actionable
- [ ] Performance is acceptable (not significantly slower than Claude)

**Deliverable:** Passing test suite and documented behavior differences

### Phase 4: Documentation & Polish (30 min - 1 hour)
**Goal:** Document OpenCode as a supported runner

Tasks:
- [ ] Update `teamos/README.md` to list OpenCode as available agent
- [ ] Add OpenCode to runner help text
- [ ] Document setup steps (install, auth, project init)
- [ ] Add troubleshooting section for OpenCode-specific issues
- [ ] Create `OPENCODE_RUNNER.md` with OpenCode-specific notes

**Files to Update:**
- `teamos/README.md` (lines ~149, ~25)
- Inline help in `run.mjs` (lines ~1117-1140)

**Deliverable:** Clear documentation for users

---

## 4. Technical Details

### 4.1 Command Invocation

**Current Claude example (working):**
```bash
node teamos/scripts/run.mjs --agent claude --member alice
```

**New OpenCode usage (target):**
```bash
node teamos/scripts/run.mjs --agent opencode --member alice
```

**Prerequisites:**
1. OpenCode installed: `npm install -g opencode-ai`
2. OpenCode authenticated: `opencode auth login`
3. Project initialized: `opencode /init` or existing `AGENTS.md`

### 4.2 Prompt Format

TeamOS passes instructions as a markdown file containing:
- Cycle rules (from `teamos/agent-rules/cycle.md`)
- Organization context
- Team member roster
- Member's profile, state, todos, schedule
- Inbox messages
- Final instruction: "Execute a cycle for **{name}** at priority level **{priority}**"

OpenCode must read this file and execute accordingly. The adapter passes:
```
opencode run --format json "Read and follow all instructions in the file: /path/to/cycle.prompt.md"
```

### 4.3 Stream-JSON Format

**Expected OpenCode output (to validate):**
```json
{"type": "user", "message": {"content": [{"type": "text", "text": "..."}]}}
{"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
{"type": "tool_call", "subtype": "started", "tool_call": {...}}
{"type": "tool_call", "subtype": "completed", "tool_call": {...}}
{"type": "result", "is_error": false, "duration_ms": 12000}
```

---

## 5. Risk Assessment & Mitigation

### Risk: OpenCode Not Available / Not in PATH
**Severity:** High  
**Mitigation:**
- Check for command availability in adapter
- Provide clear installation instructions in error message
- Fail fast before attempting to run

### Risk: Incompatible Stream-JSON Format
**Severity:** Medium  
**Mitigation:**
- Validate format during Phase 1 research
- Create comprehensive parser that handles edge cases
- Provide fallback plain-text parsing if JSON parsing fails

### Risk: Performance Degradation
**Severity:** Low-to-Medium  
**Mitigation:**
- OpenCode startup/MCP server init may be slower per cycle
- Compare performance benchmarks with Claude in testing
- Document any performance tradeoffs

### Risk: Context Size Limitations
**Severity:** Low  
**Mitigation:**
- OpenCode's context window should match or exceed Claude's
- Test with full organization context
- Monitor for truncation warnings

### Risk: Auth Persistence Issues
**Severity:** Low  
**Mitigation:**
- Document that OpenCode auth must be pre-configured
- Test auth across multiple consecutive cycles
- Handle auth errors gracefully

---

## 6. Implementation Checklist

### Research Phase
- [ ] Install OpenCode CLI
- [ ] Run sample `opencode run` command
- [ ] Capture stream-json output format
- [ ] Document any format variations
- [ ] Test error scenarios

### Code Phase
- [ ] Add OpenCode adapter to `agents` object
- [ ] Implement `formatOpenCodeJsonLine()` parser
- [ ] Update help text and options
- [ ] Add error handling for missing OpenCode
- [ ] Test adapter spawning

### Testing Phase
- [ ] Create test member/todos
- [ ] Run single pressing cycle
- [ ] Verify file modifications
- [ ] Verify git commits
- [ ] Run multiple consecutive cycles
- [ ] Test inbox processing
- [ ] Test schedule events
- [ ] Test error recovery

### Documentation Phase
- [ ] Update `README.md`
- [ ] Update inline help
- [ ] Create troubleshooting guide
- [ ] Document setup steps

### Final QA
- [ ] Code review (if applicable)
- [ ] Clean up any debug logging
- [ ] Verify no breaking changes to existing agents
- [ ] Test with multiple priority levels
- [ ] Verify logs are captured and rotated

---

## 7. Success Criteria

✅ OpenCode appears in `--agent` help text  
✅ `opencode run` command works for member cycles  
✅ Files are modified correctly  
✅ Git commits are created with proper messages  
✅ Inbox processing works  
✅ Schedule events fire correctly  
✅ Errors are handled gracefully  
✅ Documentation is clear and complete  
✅ No performance regression vs. existing agents  
✅ Logs are captured in `team/.logs/`  

---

## 8. Questions & Clarifications

Before starting implementation, confirm:

1. **Output Format:** Should we validate OpenCode's stream-json format first, or proceed with assumptions based on existing agent patterns?

2. **Error Handling:** How strictly should we validate OpenCode's presence? Should we check on runner startup, or defer until an agent is actually needed?

3. **Performance Baseline:** Should we benchmark against Claude to establish a performance baseline, or is OpenCode acceptable at any speed?

4. **Documentation Scope:** Should we create a separate `OPENCODE_RUNNER.md` file, or integrate into existing `README.md`?

5. **Testing Scope:** Should we add automated tests to the codebase, or is manual testing sufficient for this integration?

---

## 9. Timeline

**Optimistic:** 4 hours (research done quickly, parser works on first attempt)  
**Realistic:** 5-6 hours (one iteration on parser, some debugging)  
**Conservative:** 7-8 hours (format differences, auth issues, testing edge cases)

---

## 10. Next Steps

1. **User Decision:** Review this plan and confirm approach
2. **User Action:** Fork TeamOS repo for clean slate
3. **Phase 1:** Research & validation (1-2 hours)
4. **Phase 2:** Implementation (2-3 hours)
5. **Phase 3:** Testing (2-3 hours)
6. **Phase 4:** Documentation (30 min - 1 hour)

---

## Appendix A: File Modifications Summary

### `teamos/scripts/run.mjs`

**Line ~25:** Update help text
```
Agent adapter: claude | auggie | cursor | opencode  (default: claude)
```

**Lines ~197-226:** Add OpenCode adapter
```javascript
opencode: (instructionFile) => ({
  cmd: 'opencode',
  args: [
    'run',
    '--format', 'json',
    `Read and follow all instructions in the file: ${instructionFile}`
  ],
  formatStream: formatOpenCodeJsonLine,
}),
```

**Lines ~156-191:** Add parser function (after `formatCursorJsonLine`)
```javascript
function formatOpenCodeJsonLine(line) {
  // Implementation here
}
```

**Lines ~1117-1140:** Update runner help
```
--agent <name>       claude | auggie | cursor | opencode    (default: claude)
```

### `teamos/README.md`

**Line ~149:** Update available agents list
```markdown
| `--agent <name>` | `claude` | Agent adapter: `claude`, `auggie`, `cursor`, or `opencode` |
```

**Optional:** Add OpenCode setup section if needed

---

## Appendix B: Reference Links

- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [OpenCode Docs](https://opencode.ai/docs)
- [OpenCode CLI Reference](https://opencode.ai/docs/cli)
- [TeamOS Runner Code](teamos/scripts/run.mjs)
- [TeamOS Cycle Rules](teamos/agent-rules/cycle.md)

