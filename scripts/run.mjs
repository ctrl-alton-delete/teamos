#!/usr/bin/env node
/**
 * TeamOS Runner — orchestrates member cycles through the priority cascade
 * by invoking an agentic CLI tool for each active AI member.
 *
 * Version: 1.0.0
 *
 * Key design choices:
 *   - Members are discovered from team/members.json at startup.
 *   - Work detection checks inbox messages, todos at current priority,
 *     and due schedule events for each member.
 *   - Priority cascade: pressing → today → thisWeek → later.
 *     The runner advances to the next priority only when no members have
 *     work at the current level.  Within a priority level, it re-checks
 *     after each pass (members may create work for each other).
 *   - The agent owns all file changes during its cycle.  The runner commits
 *     after each member completes, keeping clean per-member commit history.
 *   - A clerk agent runs after each full pass for cleanup and error recovery.
 *   - Agent logs are captured in team/.logs/ (git-ignored), one per member per cycle.
 *
 * Usage:
 *   node teamos/scripts/run.mjs [options]
 *
 * Options:
 *   --agent <name>       Agent adapter: claude | auggie | cursor | opencode  (default: claude)
 *   --priority <level>   Starting priority: pressing | today | thisWeek | later
 *                                                                (default: pressing)
 *   --member <name>      Only run cycles for a specific member
 *   --max-cycles <n>     Max cycle passes per scheduling pass     (default: 10)
 *   --loop               Enable continuous scheduling loop
 *   --interval <min>     Minutes between passes (default: 120, implies --loop)
 *   --push               Push to remote after each commit
 *   --no-commit          Skip automatic git commit after each cycle
 *   --no-clerk           Skip clerk agent after each pass
 *   --clerk-only         Run only the clerk agent, then exit
 *   --budget <pri:n>     Max member cycles at a priority per pass (repeatable)
 *                                                (defaults: thisWeek:2, later:1)
 *   --min-interval <p:d> Min days between serving a priority (repeatable)
 *                                                (defaults: thisWeek:5, later:7)
 *   --dry-run            List members with work, don't invoke agent
 *   --help               Show this help
 */

import { readdir, readFile, access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── Path resolution ───────────────────────────────────────────────────────────
// The runner lives at teamos/scripts/run.mjs.
// teamos root = ../ from this file.  team/ and repo root are resolved from cwd.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEAMOS_ROOT = join(__dirname, '..');

function getVersion() {
	try {
		return execSync('git log -1 --format=%h', { cwd: TEAMOS_ROOT, encoding: 'utf-8' }).trim();
	} catch {
		return 'unknown';
	}
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = ['pressing', 'today', 'thisWeek', 'later'];
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung
const MAX_RUN_MS = 60 * 60 * 1000;      // 1 hour hard stop (single-run mode only)
const STOP_FILE = '.stop';              // create team/.stop to halt the runner
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2 hours between passes
const IDLE_POLL_MS = 30 * 1000;                   // poll interval during idle wait

const STARVATION_THRESHOLDS_MS = {
	pressing: 0,
	today:    24 * 60 * 60 * 1000,          // ~24h
	thisWeek: 7 * 24 * 60 * 60 * 1000,      // 7 days  (must be > MIN_INTERVAL)
	later:    14 * 24 * 60 * 60 * 1000,      // 14 days (must be > MIN_INTERVAL)
};

/** Minimum time between serving a priority level (work-week cadence for lower priorities). */
const MIN_INTERVAL_MS = {
	thisWeek: 5 * 24 * 60 * 60 * 1000,      // 5 days (work-week)
	later:    7 * 24 * 60 * 60 * 1000,       // 1 week
};

const CLERK_DAILY_MS = 24 * 60 * 60 * 1000;                // run clerk at most once per day
const EFFICIENCY_ANALYSIS_MS = 7 * 24 * 60 * 60 * 1000;    // weekly efficiency analysis

const DEFAULT_CYCLE_BUDGETS = {
	thisWeek: 2,
	later:    1,
};

// ─── Stream formatters ─────────────────────────────────────────────────────────

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done? } — when done is true the agent has emitted its
 * final result and the runner should stop waiting for a clean exit.
 */
function formatClaudeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'system' && obj.subtype === 'init') {
			return { text: `[session ${obj.session_id ?? '?'}]\n` };
		}
		if (obj.type === 'assistant') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					parts.push(`\n[ASSISTANT]\n${block.text}\n`);
				} else if (block.type === 'tool_use') {
					const inputStr = typeof block.input === 'object'
						? JSON.stringify(block.input).slice(0, 200)
						: String(block.input ?? '');
					parts.push(`\n[TOOL:${block.name}] ${inputStr}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'user') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'tool_result') {
					const text = Array.isArray(block.content)
						? block.content.map(c => c.text ?? '').join('')
						: String(block.content ?? '');
					parts.push(`  > ${text.slice(0, 200)}\n`);
				} else if (block.type === 'text' && block.text) {
					parts.push(`\n[USER]\n${block.text}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'result') {
			const status = obj.is_error ? 'ERROR' : 'DONE';
			const cost = obj.total_cost_usd != null ? ` | cost $${obj.total_cost_usd.toFixed(4)}` : '';
			const dur = obj.duration_ms != null ? ` | ${(obj.duration_ms / 1000).toFixed(1)}s` : '';
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n${obj.result ?? ''}\n`,
				done: true,
				exitCode: obj.is_error ? 1 : 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

function formatCursorJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'user') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[USER]\n${t}\n` };
		}
		if (obj.type === 'assistant') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[ASSISTANT]\n${t}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'started') {
			const tc = obj.tool_call ?? {};
			if (tc.shellToolCall) return { text: `\n[SHELL] ${tc.shellToolCall.args?.command ?? ''}\n` };
			if (tc.readToolCall) return { text: `\n[READ] ${tc.readToolCall.args?.path ?? ''}\n` };
			if (tc.editToolCall) return { text: `\n[EDIT] ${tc.editToolCall.args?.path ?? ''}\n` };
			if (tc.writeToolCall) return { text: `\n[WRITE] ${tc.writeToolCall.args?.path ?? ''}\n` };
			if (tc.grepToolCall) return { text: `\n[GREP] ${tc.grepToolCall.args?.pattern ?? ''} in ${tc.grepToolCall.args?.path ?? ''}\n` };
			if (tc.lsToolCall) return { text: `\n[LS] ${tc.lsToolCall.args?.path ?? ''}\n` };
			if (tc.deleteToolCall) return { text: `\n[DELETE] ${tc.deleteToolCall.args?.path ?? ''}\n` };
			return { text: `\n[TOOL] ${Object.keys(tc)[0] ?? '?'}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'completed') {
			const tc = obj.tool_call ?? {};
			const ok = (r) => r?.success != null;
			if (tc.shellToolCall) return { text: ok(tc.shellToolCall.result) ? `  > exit ${tc.shellToolCall.result.success?.exitCode ?? 0}\n` : `  > failed\n` };
			if (tc.readToolCall) return { text: ok(tc.readToolCall.result) ? `  > read ${tc.readToolCall.result.success?.totalLines ?? 0} lines\n` : `  > failed\n` };
			if (tc.editToolCall || tc.writeToolCall || tc.deleteToolCall) return { text: ok(Object.values(tc)[0]?.result) ? `  > done\n` : `  > failed\n` };
			return { text: `  > done\n` };
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

/**
 * Format OpenCode stream-json lines to readable text.
 * OpenCode emits: step_start, text, tool_call (started/completed), step_finish events.
 * Returns { text, done? } — when done is true the agent has emitted its final result.
 */
function formatOpenCodeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		
		// Session initialization marker
		if (obj.type === 'step_start') {
			const sessionId = obj.sessionID?.slice(0, 8) ?? '?';
			return { text: `[session ${sessionId}]\n` };
		}
		
		// Text output from the assistant
		if (obj.type === 'text') {
			const text = obj.part?.text ?? '';
			if (text) {
				return { text: `\n[ASSISTANT]\n${text}\n` };
			}
		}
		
		// Tool invocations
		if (obj.type === 'tool_call') {
			const subtype = obj.part?.subtype ?? obj.subtype ?? '';
			const toolInfo = obj.part?.toolInfo ?? {};
			
			if (subtype === 'started' || subtype === 'invoked') {
				const toolName = toolInfo.name ?? '?';
				const toolArg = JSON.stringify(toolInfo.input ?? {}).slice(0, 200);
				return { text: `\n[TOOL:${toolName}] ${toolArg}\n` };
			}
			
			if (subtype === 'completed' || subtype === 'succeeded') {
				const result = toolInfo.result ?? {};
				if (result.error) {
					return { text: `  > error: ${result.error}\n` };
				}
				return { text: `  > done\n` };
			}
		}
		
		// Step completion — indicates the agent is done
		if (obj.type === 'step_finish') {
			const reason = obj.part?.reason ?? obj.reason ?? 'unknown';
			const tokens = obj.part?.tokens ?? {};
			const cost = tokens.cost != null ? ` | cost $${(tokens.cost / 1000000).toFixed(4)}` : '';
			const dur = obj.part?.duration != null ? ` | ${(obj.part.duration / 1000).toFixed(1)}s` : '';
			
			// step_finish with reason 'stop' means the agent completed normally
			const isError = reason === 'error' || reason === 'timeout';
			const status = isError ? 'ERROR' : 'DONE';
			
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n`,
				done: true,
				exitCode: isError ? 1 : 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

// ─── Agent adapters ────────────────────────────────────────────────────────────
// Each adapter returns { cmd, args } or { shellCmd } for spawning the agent process.
// `instructionFile` is the path to a temp file containing the full prompt.

const agents = {
	claude: (instructionFile) => ({
		cmd: 'claude',
		args: [
			'-p',
			'--dangerously-skip-permissions',
			'--verbose',
			'--no-session-persistence',
			'--output-format', 'stream-json',
			'--effort', 'high',
			'--append-system-prompt-file', instructionFile,
			'Execute the member cycle as described in the appended system prompt.',
		],
		formatStream: formatClaudeJsonLine,
	}),

	auggie: (instructionFile) => ({
		cmd: 'auggie',
		args: ['--print', '--instruction', instructionFile],
	}),

	cursor: (instructionFile, _prompt, { cwd }) => {
		const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
		const prompt = `Read and follow all instructions in the file: ${relPath}`;
		return {
			shellCmd: `agent --print -f --trust --output-format stream-json --workspace "${cwd}" "${prompt}"`,
			formatStream: formatCursorJsonLine,
		};
	},

	opencode: (instructionFile, prompt, opts, opencodeServerUrl) => ({
		cmd: 'opencode',
		args: opencodeServerUrl
			? [
				'run',
				'--attach', opencodeServerUrl,
				'--format', 'json',
				`Read and follow all instructions in the file: ${instructionFile}`,
			]
			: [
				'run',
				'--format', 'json',
				`Read and follow all instructions in the file: ${instructionFile}`,
			],
		formatStream: formatOpenCodeJsonLine,
	}),
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function pathExists(filePath) {
	try { await access(filePath, constants.R_OK); return true; } catch { return false; }
}

async function readTextOrEmpty(filePath) {
	try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
}

async function checkStop(teamDir) {
	const stopFile = join(teamDir, STOP_FILE);
	if (await pathExists(stopFile)) {
		await unlink(stopFile).catch(() => {});
		return true;
	}
	return false;
}

// ─── Time formatting ───────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatTimestamp() {
	const now = new Date();
	const day = DAY_NAMES[now.getDay()];
	const month = MONTH_NAMES[now.getMonth()];
	const date = now.getDate();
	const year = now.getFullYear();
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
	const offM = String(Math.abs(offset) % 60).padStart(2, '0');
	const h = String(now.getHours()).padStart(2, '0');
	const m = String(now.getMinutes()).padStart(2, '0');
	const isoLocal = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}T${h}:${m}:${String(now.getSeconds()).padStart(2, '0')}${sign}${offH}:${offM}`;
	return `${day}, ${month} ${date}, ${year} ${h}:${m} local (${isoLocal})`;
}

// ─── Scheduling helpers ────────────────────────────────────────────────────────

function getStarvedPriority(lastServedAt, currentPriority) {
	const now = Date.now();
	const currentIdx = PRIORITY_ORDER.indexOf(currentPriority);
	for (let i = currentIdx + 1; i < PRIORITY_ORDER.length; i++) {
		const priority = PRIORITY_ORDER[i];
		const threshold = STARVATION_THRESHOLDS_MS[priority];
		if (!threshold) continue;
		const last = lastServedAt[priority];
		if (last == null || (now - last) >= threshold) return priority;
	}
	return null;
}

async function idleWait(ms, teamDir, members) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await checkStop(teamDir)) return 'stop';
		if ((await getMembersWithWork(members, 'today', teamDir)).length > 0) return 'work';
		const remaining = end - Date.now();
		const delay = Math.min(IDLE_POLL_MS, remaining);
		if (delay > 0) await new Promise(r => setTimeout(r, delay));
	}
	return 'interval';
}

async function loadSchedulerState(logsDir) {
	try {
		const raw = await readFile(join(logsDir, 'scheduler-state.json'), 'utf-8');
		const state = JSON.parse(raw);
		const now = Date.now();
		const lastServedAt = {};
		for (const p of PRIORITY_ORDER) {
			const ts = state.lastServedAt?.[p];
			lastServedAt[p] = (typeof ts === 'number' && ts > 0 && ts <= now) ? ts : now;
		}
		const lastServedMember = state.lastServedMember ?? {};
		const validTs = (v) => typeof v === 'number' && v > 0 && v <= now ? v : 0;
		const lastClerkAt = validTs(state.lastClerkAt);
		const lastEfficiencyAt = validTs(state.lastEfficiencyAt);
		console.log('[runner] Restored scheduler state from previous run.');
		return { lastServedAt, lastServedMember, lastClerkAt, lastEfficiencyAt };
	} catch {
		const lastServedAt = {};
		for (const p of PRIORITY_ORDER) lastServedAt[p] = Date.now();
		return { lastServedAt, lastServedMember: {}, lastClerkAt: 0, lastEfficiencyAt: 0 };
	}
}

async function saveSchedulerState(logsDir, state) {
	const out = {
		lastServedAt: state.lastServedAt,
		lastServedMember: state.lastServedMember,
		lastClerkAt: state.lastClerkAt,
		lastEfficiencyAt: state.lastEfficiencyAt,
		updatedAt: new Date().toISOString(),
	};
	await writeFile(
		join(logsDir, 'scheduler-state.json'),
		JSON.stringify(out, null, '\t') + '\n', 'utf-8',
	).catch(() => {});
}

/** Rotate membersWithWork so the member after lastServed is first (round-robin fairness). */
function rotateAfter(membersWithWork, lastServedName) {
	if (!lastServedName || membersWithWork.length <= 1) return membersWithWork;
	const idx = membersWithWork.findIndex(m => m.name === lastServedName);
	if (idx < 0) return membersWithWork;
	return [...membersWithWork.slice(idx + 1), ...membersWithWork.slice(0, idx + 1)];
}

// ─── Automated housekeeping ─────────────────────────────────────────────────────
// Lightweight JS checks that replace the per-cycle clerk for routine tasks.

function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * Run automated housekeeping: archive expired memos, prune stale schedule events,
 * validate JSON files.  Returns { fixed: string[], errors: string[] }.
 */
async function runHousekeeping(teamDir, members) {
	const fixed = [];
	const errors = [];

	// 1. Archive expired memos
	const memosPath = join(teamDir, 'memos.json');
	try {
		const raw = await readFile(memosPath, 'utf-8');
		const memos = JSON.parse(raw);
		const now = new Date();
		const expired = (memos.items ?? []).filter(m => m.expiresAt && new Date(m.expiresAt) < now);
		if (expired.length > 0) {
			const archiveDir = join(teamDir, 'archives');
			await mkdir(archiveDir, { recursive: true });
			for (const memo of expired) {
				const archivePath = join(archiveDir, `memo-${slugify(memo.title)}.json`);
				await writeFile(archivePath, JSON.stringify(memo, null, '\t') + '\n', 'utf-8');
			}
			memos.items = memos.items.filter(m => !expired.includes(m));
			await writeFile(memosPath, JSON.stringify(memos, null, '\t') + '\n', 'utf-8');
			fixed.push(`Archived ${expired.length} expired memo(s)`);
		}
	} catch (e) {
		errors.push(`memos.json: ${e.message}`);
	}

	// 2. Prune schedule events older than 1 week (non-recurring only)
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	for (const member of members) {
		const schedulePath = join(teamDir, 'members', member.name, 'schedule.json');
		try {
			const raw = await readFile(schedulePath, 'utf-8');
			const schedule = JSON.parse(raw);
			const stale = (schedule.events ?? []).filter(e => !e.recurring && new Date(e.time) < weekAgo);
			if (stale.length > 0) {
				schedule.events = schedule.events.filter(e => !stale.includes(e));
				await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
				fixed.push(`Pruned ${stale.length} stale event(s) from ${member.name}'s schedule`);
			}
		} catch { /* missing file is fine */ }
	}

	// 3. Archive completed/cancelled projects
	const projectsPath = join(teamDir, 'projects.json');
	try {
		const raw = await readFile(projectsPath, 'utf-8');
		const manifest = JSON.parse(raw);
		const done = (manifest.projects ?? []).filter(p => p.status === 'completed' || p.status === 'cancelled');
		if (done.length > 0) {
			const archiveDir = join(teamDir, 'archives');
			await mkdir(archiveDir, { recursive: true });
			for (const proj of done) {
				const archivePath = join(archiveDir, `project-${slugify(proj.code)}.json`);
				await writeFile(archivePath, JSON.stringify(proj, null, '\t') + '\n', 'utf-8');
			}
			manifest.projects = manifest.projects.filter(p => !done.includes(p));
			await writeFile(projectsPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');
			fixed.push(`Archived ${done.length} completed/cancelled project(s)`);
		}
	} catch (e) {
		errors.push(`projects.json: ${e.message}`);
	}

	// 4. Validate key JSON files
	for (const member of members) {
		for (const file of ['todo.json', 'schedule.json']) {
			const filePath = join(teamDir, 'members', member.name, file);
			try {
				const raw = await readFile(filePath, 'utf-8');
				JSON.parse(raw);
			} catch (e) {
				if (e.code !== 'ENOENT') errors.push(`${member.name}/${file}: ${e.message}`);
			}
		}
	}

	return { fixed, errors };
}

// ─── Log scanning (for efficiency analysis) ─────────────────────────────────────

/**
 * Scan recent log files and return per-member summary stats.
 * Used to build the efficiency analysis prompt without the agent reading every log.
 */
async function scanRecentLogs(logsDir, days = 7) {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	let files;
	try { files = await readdir(logsDir); } catch { return []; }

	const entries = [];
	for (const file of files) {
		if (!file.endsWith('.log')) continue;
		const match = file.match(/^(.+?)\.(.+?)\.(\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-(\d{2})-(\d+)Z)\.log$/);
		if (!match) continue;
		const [, member, priority, , hh, mm, ss, ms] = match;
		const tsStr = match[3].replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z/, '$1T$2:$3:$4.$5Z');
		const ts = new Date(tsStr);
		if (isNaN(ts.getTime()) || ts.getTime() < cutoff) continue;

		// Read tail to extract cost/duration without loading full file
		const content = await readTextOrEmpty(join(logsDir, file));
		const tail = content.slice(-600);
		const costMatch = tail.match(/cost \$([0-9.]+)/);
		const durMatch = tail.match(/\| ([0-9.]+)s/);
		const rateLimited = content.includes('"status":"rejected"');

		entries.push({
			file, member, priority,
			timestamp: ts.toISOString(),
			cost: costMatch ? parseFloat(costMatch[1]) : 0,
			durationSec: durMatch ? parseFloat(durMatch[1]) : 0,
			rateLimited,
			sizeKB: Math.round(content.length / 1024),
		});
	}

	return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Build a per-member summary table from log entries.
 */
function buildLogSummary(entries) {
	const byMember = {};
	for (const e of entries) {
		if (e.member === 'clerk') continue;
		const key = e.member;
		if (!byMember[key]) byMember[key] = { runs: 0, totalCost: 0, rateLimited: 0, byPriority: {} };
		const m = byMember[key];
		m.runs++;
		m.totalCost += e.cost;
		if (e.rateLimited) m.rateLimited++;
		if (!m.byPriority[e.priority]) m.byPriority[e.priority] = { runs: 0, cost: 0 };
		m.byPriority[e.priority].runs++;
		m.byPriority[e.priority].cost += e.cost;
	}

	const lines = ['| Member | Runs | Cost | Rate-limited | By priority |',
		'|--------|------|------|-------------|-------------|'];
	for (const [name, m] of Object.entries(byMember).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
		const priStr = Object.entries(m.byPriority)
			.map(([p, d]) => `${p}:${d.runs}/$${d.cost.toFixed(2)}`)
			.join(', ');
		lines.push(`| ${name} | ${m.runs} | $${m.totalCost.toFixed(2)} | ${m.rateLimited} | ${priStr} |`);
	}
	return lines.join('\n');
}

// ─── Post-pass maintenance ──────────────────────────────────────────────────────

async function buildEfficiencyPrompt(teamDir, logsDir, members) {
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'clerk-efficiency.md');
	const rules = await readTextOrEmpty(rulesFile);
	const membersDoc = await readTextOrEmpty(join(teamDir, 'members.json'));

	const entries = await scanRecentLogs(logsDir, 7);
	const summaryTable = buildLogSummary(entries);

	// List the 30 most expensive non-rate-limited logs for the agent to investigate
	const interesting = entries
		.filter(e => !e.rateLimited && e.member !== 'clerk')
		.sort((a, b) => b.cost - a.cost)
		.slice(0, 30);
	const logList = interesting.map(e =>
		`  ${e.file}  ($${e.cost.toFixed(2)}, ${e.durationSec.toFixed(0)}s, ${e.sizeKB}KB)`
	).join('\n');

	return [
		'# TeamOS Weekly Efficiency Analysis',
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
		`# Logs directory: team/.logs/`,
		'',
		'## Team Members',
		'',
		membersDoc,
		'',
		'## Last 7 Days — Summary',
		'',
		summaryTable,
		'',
		'## Most Expensive Runs (non-rate-limited)',
		'',
		logList || '(none)',
		'',
		'## Rules',
		'',
		rules,
		'',
		'## Instructions',
		'',
		'Analyze the logs listed above for repeated inefficiency patterns.',
		'Read the actual log files (in team/.logs/) to understand what the agent did.',
		'Send inbox messages ONLY for repeated patterns — not one-time fumbles.',
		'Do NOT commit — the runner handles commits after you complete.',
	].join('\n');
}

/**
 * Post-pass maintenance: automated housekeeping, conditional clerk, weekly efficiency analysis.
 * Replaces the per-cycle clerk invocation.
 */
async function runMaintenance({ opts, teamDir, logsDir, version, repoRoot, members, schedulerState, passErrors, opencodeServerUrl }) {
	const now = Date.now();

	// 1. Automated housekeeping (lightweight JS — no agent)
	const issues = await runHousekeeping(teamDir, members);
	if (issues.fixed.length > 0) {
		console.log(`[runner] Housekeeping: ${issues.fixed.join('; ')}`);
		if (!opts.noCommit) {
			if (commitChanges('housekeeping: automated cleanup', repoRoot)) {
				console.log('  Housekeeping committed.');
				if (opts.push) pushChanges(repoRoot);
			}
		}
	}
	if (issues.errors.length > 0) {
		console.log(`[runner] Housekeeping issues: ${issues.errors.join('; ')}`);
	}

	// 2. Clerk: run if issues need agent intervention, errors occurred, or ≥24h since last run
	const errorContext = [...(passErrors ?? []), ...issues.errors];
	const timeSinceClerk = now - (schedulerState.lastClerkAt ?? 0);
	const needsClerk = errorContext.length > 0 || timeSinceClerk >= CLERK_DAILY_MS;

	if (needsClerk && !opts.noClerk) {
		console.log('\n[runner] Running daily clerk...');
		const clerkLog = buildLogPath(logsDir, 'clerk', 'maintenance');

		await writeFile(clerkLog, [
			`Clerk run (maintenance)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			errorContext.length > 0 ? `Issues: ${errorContext.join('; ')}` : 'No issues.',
			'═'.repeat(72),
			'',
		].join('\n'));

		const clerkPrompt = await buildClerkPrompt(teamDir, errorContext.length > 0 ? errorContext.join('\n') : null);
		const clerkExit = await runAgent(opts.agent, clerkPrompt, repoRoot, clerkLog, opencodeServerUrl);

		if (clerkExit !== 0) {
			console.error(`[runner] Clerk exited with code ${clerkExit}`);
		}

		if (!opts.noCommit) {
			if (commitChanges('clerk: maintenance', repoRoot)) {
				console.log('  Clerk committed.');
				if (opts.push) pushChanges(repoRoot);
			}
		}

		schedulerState.lastClerkAt = Date.now();
	}

	// 3. Weekly efficiency analysis
	const timeSinceAnalysis = now - (schedulerState.lastEfficiencyAt ?? 0);
	if (!opts.noClerk && timeSinceAnalysis >= EFFICIENCY_ANALYSIS_MS) {
		console.log('\n[runner] Running weekly efficiency analysis...');
		const analysisLog = buildLogPath(logsDir, 'clerk', 'efficiency');

		await writeFile(analysisLog, [
			`Clerk run (weekly efficiency analysis)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildEfficiencyPrompt(teamDir, logsDir, members);
		const analysisExit = await runAgent(opts.agent, prompt, repoRoot, analysisLog, opencodeServerUrl);

		if (analysisExit !== 0) {
			console.error(`[runner] Efficiency analysis exited with code ${analysisExit}`);
		}

		if (!opts.noCommit) {
			if (commitChanges('clerk: weekly efficiency analysis', repoRoot)) {
				console.log('  Analysis committed.');
				if (opts.push) pushChanges(repoRoot);
			}
		}

		schedulerState.lastEfficiencyAt = Date.now();
	}
}

// ─── Member discovery ──────────────────────────────────────────────────────────

async function loadMembers(teamDir) {
	const content = await readFile(join(teamDir, 'members.json'), 'utf-8');
	const manifest = JSON.parse(content);
	return manifest.members
		.filter(m => m.active && m.type === 'ai');
}

// ─── Work detection ────────────────────────────────────────────────────────────

/**
 * Determine if a schedule event is currently due.
 * Non-recurring: due if time <= now.
 * Recurring: due if the event's `time` field is <= now.  After the agent
 * handles a recurring event, the runner advances `time` to the next
 * occurrence so it won't re-trigger until then.
 */
function isEventDue(event, now) {
	return new Date(event.time) <= now;
}

/**
 * Compute the next occurrence of a recurring event after `after`.
 * Steps forward from `base` by the recurrence interval until the result > after.
 */
function nextOccurrence(base, recurrence, after) {
	const { frequency, interval = 1 } = recurrence;

	if (frequency === 'daily') {
		const ms = interval * 24 * 60 * 60 * 1000;
		const periods = Math.ceil((after - base) / ms);
		return new Date(base.getTime() + Math.max(1, periods) * ms);
	}

	if (frequency === 'weekly') {
		const ms = interval * 7 * 24 * 60 * 60 * 1000;
		const periods = Math.ceil((after - base) / ms);
		return new Date(base.getTime() + Math.max(1, periods) * ms);
	}

	if (frequency === 'monthly') {
		let d = new Date(base);
		while (d <= after) {
			d = new Date(d);
			d.setMonth(d.getMonth() + interval);
		}
		return d;
	}

	return new Date(base.getTime() + interval * 24 * 60 * 60 * 1000);
}

async function memberHasWork(memberName, priority, teamDir) {
	const memberDir = join(teamDir, 'members', memberName);

	// Check inbox for messages
	const inboxDir = join(memberDir, 'inbox');
	if (await pathExists(inboxDir)) {
		try {
			const files = await readdir(inboxDir);
			if (files.some(f => f.endsWith('.md'))) return true;
		} catch { /* ignore */ }
	}

	// Check todos at this priority or higher
	const todoPath = join(memberDir, 'todo.json');
	if (await pathExists(todoPath)) {
		try {
			const todos = JSON.parse(await readFile(todoPath, 'utf-8'));
			const priorityIdx = PRIORITY_ORDER.indexOf(priority);
			if (todos.items.some(t => t.status !== 'blocked' && PRIORITY_ORDER.indexOf(t.priority) <= priorityIdx)) return true;
		} catch { /* ignore */ }
	}

	// Check schedule for due events
	const schedulePath = join(memberDir, 'schedule.json');
	if (await pathExists(schedulePath)) {
		try {
			const schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
			const now = new Date();
			if (schedule.events.some(e => isEventDue(e, now))) return true;
		} catch { /* ignore */ }
	}

	return false;
}

/**
 * After a member's cycle, advance any due recurring events to their next
 * occurrence so they don't re-trigger until the next period.
 */
async function advanceRecurringEvents(memberName, teamDir) {
	const schedulePath = join(teamDir, 'members', memberName, 'schedule.json');
	try {
		const raw = await readFile(schedulePath, 'utf-8');
		const schedule = JSON.parse(raw);
		const now = new Date();
		let changed = false;
		for (const event of (schedule.events ?? [])) {
			if (event.recurring && event.recurrence && new Date(event.time) <= now) {
				event.time = nextOccurrence(new Date(event.time), event.recurrence, now).toISOString();
				changed = true;
			}
		}
		if (changed) {
			await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
		}
	} catch { /* missing or invalid schedule is fine */ }
}

async function getMembersWithWork(members, priority, teamDir) {
	const results = [];
	for (const member of members) {
		if (await memberHasWork(member.name, priority, teamDir)) {
			results.push(member);
		}
	}
	return results;
}

// ─── Self-assessment schedule injection ─────────────────────────────────────────

const SELF_ASSESSMENT_TITLE = 'Weekly Self-Assessment';

/**
 * Compute the next Friday at 18:00 UTC on or after the given date.
 */
function nextFriday(from = new Date()) {
	const d = new Date(from);
	d.setUTCHours(18, 0, 0, 0);
	const day = d.getUTCDay(); // 0=Sun … 5=Fri
	const daysUntilFri = (5 - day + 7) % 7 || 7; // at least 1 day ahead
	d.setUTCDate(d.getUTCDate() + daysUntilFri);
	return d;
}

function buildSelfAssessmentEvent(fromDate) {
	return {
		title: SELF_ASSESSMENT_TITLE,
		description:
			'Conduct a weekly self-assessment following the rules in teamos/agent-rules/self-assessment.md. ',
		time: nextFriday(fromDate).toISOString(),
		recurring: true,
		recurrence: {
			frequency: 'weekly',
			interval: 1,
		},
	};
}

/**
 * Ensure every active AI member has a Weekly Self-Assessment schedule event.
 * Adds one (persisted) if missing; leaves existing ones untouched.
 */
async function ensureSelfAssessmentEvents(members, teamDir) {
	let added = 0;
	for (const member of members) {
		const schedulePath = join(teamDir, 'members', member.name, 'schedule.json');
		let schedule;
		try {
			schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
		} catch {
			schedule = { events: [] };
		}

		const hasAssessment = schedule.events.some(
			e => e.title === SELF_ASSESSMENT_TITLE,
		);
		if (!hasAssessment) {
			schedule.events.push(buildSelfAssessmentEvent(new Date()));
			await writeFile(schedulePath, JSON.stringify(schedule, null, '\t') + '\n', 'utf-8');
			added++;
		}
	}
	if (added > 0) {
		console.log(`[runner] Added self-assessment schedule event to ${added} member(s).`);
	}
}

// ─── Logging ───────────────────────────────────────────────────────────────────

async function ensureLogsDir(teamDir) {
	const logsDir = join(teamDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

function buildLogPath(logsDir, label, priority) {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${label}.${priority}.${ts}.log`);
}

// ─── Prompt building ───────────────────────────────────────────────────────────

async function readInboxMessages(memberDir) {
	const inboxDir = join(memberDir, 'inbox');
	try {
		const files = await readdir(inboxDir);
		const mdFiles = files.filter(f => f.endsWith('.md'));
		const messages = [];
		for (const file of mdFiles) {
			const content = await readTextOrEmpty(join(inboxDir, file));
			if (content) messages.push({ file, content });
		}
		return messages;
	} catch {
		return [];
	}
}

async function buildCyclePrompt(member, priority, teamDir) {
	const memberDir = join(teamDir, 'members', member.name);
	const rulesFile = join(TEAMOS_ROOT, 'agent-rules', 'cycle.md');

	const [rules, orgDoc, memosDoc, projectsDoc, membersDoc,
		profile, state, todos, schedule] = await Promise.all([
		readTextOrEmpty(rulesFile),
		readTextOrEmpty(join(teamDir, 'org.md')),
		readTextOrEmpty(join(teamDir, 'memos.json')),
		readTextOrEmpty(join(teamDir, 'projects.json')),
		readTextOrEmpty(join(teamDir, 'members.json')),
		readTextOrEmpty(join(memberDir, 'profile.md')),
		readTextOrEmpty(join(memberDir, 'state.md')),
		readTextOrEmpty(join(memberDir, 'todo.json')),
		readTextOrEmpty(join(memberDir, 'schedule.json')),
	]);

	const inboxMessages = await readInboxMessages(memberDir);

	const parts = [
		`# TeamOS Cycle: ${member.name} (${member.title})`,
		`# Priority: ${priority}`,
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
		`# Member directory: team/members/${member.name}/`,
		'',
		'## Organization',
		'',
		orgDoc,
		'',
		'## Memos',
		'',
		memosDoc,
		'',
		'## Projects',
		'',
		projectsDoc,
		'',
		'## Team Members',
		'',
		membersDoc,
		'',
		'---',
		'',
		`## Your Profile (${member.name})`,
		'',
		profile || '_No profile found._',
		'',
		'## Your Current State',
		'',
		state || '_No state file found._',
		'',
		'## Your TODOs',
		'',
		todos || '{"items":[]}',
		'',
		'## Your Schedule',
		'',
		schedule || '{"events":[]}',
	];

	if (inboxMessages.length > 0) {
		parts.push('', '## Your Inbox Messages', '');
		for (const msg of inboxMessages) {
			parts.push(`### ${msg.file}`, '', msg.content, '');
		}
	} else {
		parts.push('', '## Your Inbox', '', 'No messages.', '');
	}

	parts.push(
		'',
		'## Cycle Rules',
		'',
		rules,
		'',
		'----',
		'',
		`Execute a cycle for **${member.name}** at priority level **${priority}**.`,
	);

	return parts.join('\n');
}

async function buildClerkPrompt(teamDir, error) {
	const clerkRules = await readTextOrEmpty(join(TEAMOS_ROOT, 'agent-rules', 'clerk.md'));
	const systemDoc = await readTextOrEmpty(join(TEAMOS_ROOT, 'README.md'));

	const parts = [
		'# TeamOS Clerk',
		`# Time: ${formatTimestamp()}`,
		`# Team directory: team/`,
		'',
		'## System Architecture',
		'',
		systemDoc,
		'',
		'## Clerk Rules',
		'',
		clerkRules,
	];

	if (error) {
		parts.push(
			'',
			'## Error Context',
			'',
			'The following error occurred during the last cycle:',
			'',
			error,
		);
	}

	parts.push(
		'',
		'## Instructions',
		'',
		'Run cleanup as described in the clerk rules above.',
		'Do NOT commit — the runner handles commits after you complete.',
	);

	return parts.join('\n');
}

// ─── Agent invocation ──────────────────────────────────────────────────────────

/**
 * Check if an agent command is available in PATH.
 * For OpenCode, this also validates authentication.
 */
async function validateAgent(agentName) {
	const adapter = agents[agentName];
	if (!adapter) {
		throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
	}

	// Check if command exists
	const { cmd, shellCmd } = adapter('', '', { cwd: process.cwd() }, null);
	const command = cmd || (shellCmd ? shellCmd.split(' ')[0] : null);

	if (!command) {
		throw new Error(`No command found for agent: ${agentName}`);
	}

	try {
		execSync(`command -v ${command}`, { stdio: 'ignore', shell: true });
	} catch {
		if (agentName === 'opencode') {
			throw new Error(
				'OpenCode not found in PATH.\n' +
				'  Install: npm install -g opencode-ai\n' +
				'  Auth:    opencode auth login'
			);
		}
		throw new Error(`Agent command not found: ${command}`);
	}

	// Note: For OpenCode, we skip auth status check here because
	// the serve mode handles authentication internally during startup.
}

let opencodeServerProcess = null;
let opencodeServerUrl = null;

async function startOpenCodeServer(cwd) {
	if (opencodeServerProcess || opencodeServerUrl) return opencodeServerUrl;

	console.log('[runner] Starting opencode server...');
	try {
		opencodeServerProcess = spawn('opencode', ['serve', '--port', '0'], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const urlPromise = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Server start timeout')), 30000);
			opencodeServerProcess.stdout.on('data', (chunk) => {
				const output = chunk.toString();
				const match = output.match(/http:\/\/localhost:\d+/);
				if (match) {
					clearTimeout(timeout);
					resolve(match[0]);
				}
			});
			opencodeServerProcess.stderr.on('data', (chunk) => {
				const output = chunk.toString();
				process.stderr.write(`[opencode serve] ${output}`);
				const match = output.match(/http:\/\/localhost:\d+/);
				if (match) {
					clearTimeout(timeout);
					resolve(match[0]);
				}
			});
		});

		opencodeServerUrl = await urlPromise;
		console.log(`[runner] OpenCode server started at ${opencodeServerUrl}`);
		return opencodeServerUrl;
	} catch (err) {
		console.error(`[runner] Failed to start opencode server: ${err.message}`);
		if (opencodeServerProcess) {
			opencodeServerProcess.kill();
			opencodeServerProcess = null;
		}
		return null;
	}
}

async function stopOpenCodeServer() {
	if (opencodeServerProcess) {
		console.log('[runner] Stopping opencode server...');
		opencodeServerProcess.kill();
		opencodeServerProcess = null;
		opencodeServerUrl = null;
	}
}

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code. */
async function runAgent(agentName, prompt, cwd, logFile, serverUrl) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	const adapterResult = agentName === 'opencode' && serverUrl
		? adapter(instructionFile, prompt, { cwd }, serverUrl)
		: adapter(instructionFile, prompt, { cwd });
	const logStream = createWriteStream(logFile, { flags: 'a' });
	const { cmd, args, shellCmd, formatStream } = adapterResult;

	const spawnArgs = shellCmd
		? [shellCmd, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true }]
		: [cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false }];

	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(...spawnArgs);
			let idleTimer = null;
			let resultExitCode = null;
			let settled = false;

			function settle(code) {
				if (settled) return;
				settled = true;
				clearTimeout(idleTimer);
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				logStream.once('finish', () => resolve(code));
				logStream.once('error', () => resolve(code));
			}

			function resetIdleTimer() {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					const msg = `\n[runner] Agent idle for ${IDLE_TIMEOUT_MS / 60000}min — killing as hung.\n`;
					process.stderr.write(msg);
					logStream.write(msg);
					child.kill();
				}, IDLE_TIMEOUT_MS);
			}

			resetIdleTimer();

			function writeOut(text) {
				process.stdout.write(text);
				if (!logStream.write(text)) {
					child.stdout.pause();
					logStream.once('drain', () => child.stdout.resume());
				}
			}

			function processLine(line) {
				if (!formatStream) { writeOut(line + '\n'); return; }
				const result = formatStream(line);
				if (result.text) writeOut(result.text);
				if (result.done) {
					resultExitCode = result.exitCode ?? 0;
					clearTimeout(idleTimer);
					// Give agent 30s to exit after sending result
					idleTimer = setTimeout(() => {
						const msg = `\n[runner] Agent sent result but didn't exit — killing stale process.\n`;
						process.stderr.write(msg);
						logStream.write(msg);
						child.kill();
					}, 30_000);
				}
			}

			let buf = '';
			child.stdout.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) processLine(line);
			});

			child.stderr.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				process.stderr.write(chunk);
				logStream.write(chunk);
			});

			child.on('error', (err) => {
				const label = shellCmd ? 'agent' : cmd;
				console.error(`Failed to spawn ${label}: ${err.message}`);
				logStream.end(`\n[runner] Agent spawn error: ${err.message}\n`);
				logStream.once('finish', () => reject(err));
				logStream.once('error', () => reject(err));
			});

			child.on('close', (code) => {
				if (buf) processLine(buf.trimEnd());
				settle(resultExitCode ?? code ?? 1);
			});
		});
	} finally {
		process.stdout.write('\x1b[0m');
		await unlink(instructionFile).catch(() => {});
	}
}

// ─── Git commit ────────────────────────────────────────────────────────────────

/** Stage and commit all changes.  Returns true if a commit was created. */
function commitChanges(message, cwd) {
	try {
		const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
		if (!status) return false;

		execSync('git add -A', { cwd, encoding: 'utf-8' });
		execSync(`git commit -m "${message}"`, { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

/** Push to the remote tracking branch. Returns true on success. */
function pushChanges(cwd) {
	try {
		execSync('git push', { cwd, encoding: 'utf-8', stdio: 'pipe' });
		console.log('  Pushed.');
		return true;
	} catch (err) {
		console.error(`[runner] Git push failed: ${err.stderr || err.message}`);
		return false;
	}
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
	const lines = [
		'TeamOS Runner — orchestrate member cycles via agentic CLI',
		'',
		'Members are discovered from team/members.json.  Work is detected by',
		'checking inbox messages, todos at the current priority, and due schedule',
		'events.  The priority cascade runs: pressing → today → thisWeek → later.',
		'',
		'Usage: node teamos/scripts/run.mjs [options]',
		'',
		'Options:',
		'  --agent <name>       claude | auggie | cursor | opencode   (default: claude)',
		'  --priority <level>   Starting priority level               (default: pressing)',
		'  --member <name>      Only run cycles for a specific member',
		'  --max-cycles <n>     Max cycle passes per scheduling pass  (default: 10)',
		'  --loop               Enable continuous scheduling loop',
		'  --interval <min>     Minutes between passes                (default: 120, implies --loop)',
		'  --push               Push to remote after each commit',
		'  --no-commit          Skip automatic git commit after each cycle',
		'  --no-clerk           Skip clerk agent after each pass',
		'  --clerk-only         Run only the clerk agent, then exit',
		'  --budget <pri:n>     Max member cycles at a priority per pass (repeatable)',
		'                         (defaults: thisWeek:2, later:1)',
		'  --min-interval <p:d> Min days between serving a priority (repeatable)',
		'                         (defaults: thisWeek:5, later:7)',
		'  --dry-run            List members with work, don\'t invoke agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

function parseArgs(argv) {
	const opts = {
		agent: 'claude',
		priority: 'pressing',
		member: null,
		maxCycles: 10,
		loop: false,
		intervalMs: DEFAULT_INTERVAL_MS,
		push: false,
		noCommit: false,
		noClerk: false,
		clerkOnly: false,
		dryRun: false,
		budgets: { ...DEFAULT_CYCLE_BUDGETS },
		minIntervals: { ...MIN_INTERVAL_MS },
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--priority':
				opts.priority = argv[++i];
				break;
			case '--member':
				opts.member = argv[++i];
				break;
			case '--max-cycles':
				opts.maxCycles = parseInt(argv[++i], 10);
				break;
			case '--loop':
				opts.loop = true;
				break;
			case '--interval':
				opts.intervalMs = parseInt(argv[++i], 10) * 60 * 1000;
				opts.loop = true;
				break;
			case '--push':
				opts.push = true;
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--no-clerk':
				opts.noClerk = true;
				break;
			case '--clerk-only':
				opts.clerkOnly = true;
				break;
			case '--budget': {
				const spec = argv[++i]; // e.g. "later:2" or "thisWeek:3"
				if (spec) {
					const [pri, count] = spec.split(':');
					if (PRIORITY_ORDER.includes(pri) && !isNaN(parseInt(count, 10))) {
						opts.budgets[pri] = parseInt(count, 10);
					} else {
						console.error(`Invalid --budget spec: "${spec}". Use priority:count (e.g. later:2)`);
						process.exit(1);
					}
				}
				break;
			}
			case '--min-interval': {
				const spec = argv[++i]; // e.g. "thisWeek:5" (days)
				if (spec) {
					const [pri, days] = spec.split(':');
					if (PRIORITY_ORDER.includes(pri) && !isNaN(parseFloat(days))) {
						opts.minIntervals[pri] = parseFloat(days) * 24 * 60 * 60 * 1000;
					} else {
						console.error(`Invalid --min-interval spec: "${spec}". Use priority:days (e.g. thisWeek:5)`);
						process.exit(1);
					}
				}
				break;
			}
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	if (!PRIORITY_ORDER.includes(opts.priority)) {
		console.error(`Unknown priority: "${opts.priority}". Valid: ${PRIORITY_ORDER.join(', ')}`);
		process.exit(1);
	}

	return opts;
}

// ─── Cycle execution ───────────────────────────────────────────────────────────

async function runCycle({ membersWithWork, priority, cycleCount, opts, teamDir, logsDir, version, repoRoot, startTime, useTimeout }) {
	let memberRuns = 0;
	let lastError = null;
	let stopped = false;

	for (const member of membersWithWork) {
		if (useTimeout && (Date.now() - startTime) >= MAX_RUN_MS) break;
		if (await checkStop(teamDir)) { stopped = true; break; }

		memberRuns++;
		const currentLog = buildLogPath(logsDir, member.name, priority);

		console.log([
			`${'─'.repeat(72)}`,
			`  ${member.name} (${member.title})`,
			`  Priority: ${priority}  |  Cycle: ${cycleCount}`,
			`  Log: ${currentLog}`,
			`${'─'.repeat(72)}`,
		].join('\n'));

		await writeFile(currentLog, [
			`Member: ${member.name} (${member.title})`,
			`Priority: ${priority}`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildCyclePrompt(member, priority, teamDir);
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, opencodeServerUrl);

		if (exitCode !== 0) {
			lastError = `Agent exited with code ${exitCode} for member: ${member.name}`;
			console.error(`\n${lastError}`);
			console.error(`Log: ${currentLog}`);
		}

		console.log(`\n  Complete: ${member.name}\n`);

		await advanceRecurringEvents(member.name, teamDir);

		if (membersWithWork.indexOf(member) < membersWithWork.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	if (!opts.noCommit) {
		const names = membersWithWork.map(m => m.name).join(', ');
		const label = `cycle ${cycleCount} (${priority}): ${names}`;
		if (commitChanges(label, repoRoot)) {
			console.log('  Committed.');
			if (opts.push) pushChanges(repoRoot);
		}
	}

	return { memberRuns, stopped, lastError };
}

// ─── Pass execution ────────────────────────────────────────────────────────────

async function runPass({ opts, teamDir, logsDir, version, repoRoot, members, schedulerState, useTimeout, opencodeServerUrl }) {
	const { lastServedAt, lastServedMember } = schedulerState;
	const startTime = Date.now();
	let currentPriority = opts.priority;
	let cycleCount = 0;
	let totalMemberRuns = 0;
	const budgetSpent = {};
	const passErrors = [];

	function isBudgetExhausted(priority) {
		const cap = opts.budgets[priority];
		if (cap == null) return false;
		return (budgetSpent[priority] ?? 0) >= cap;
	}

	while (cycleCount < opts.maxCycles) {
		if (useTimeout && (Date.now() - startTime) >= MAX_RUN_MS) {
			return { cycleCount, totalMemberRuns, stopped: false, timedOut: true, passErrors };
		}

		if (await checkStop(teamDir)) {
			return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
		}

		// Starvation check: force a cycle at a neglected priority before it drifts too far
		// Starvation overrides budgets — that's the whole point of the safety net
		const starved = getStarvedPriority(lastServedAt, currentPriority);
		if (starved) {
			const starvedMembers = await getMembersWithWork(members, starved, teamDir);
			if (starvedMembers.length > 0) {
				const last = lastServedAt[starved];
				const agoH = last != null ? Math.round((Date.now() - last) / 3600000) : '∞';
				console.log(`\n[runner] Priority "${starved}" starved (last served ${agoH}h ago) — injecting cycle`);

				cycleCount++;
				console.log(`\n[runner] Cycle ${cycleCount}, priority: ${starved} (starvation), ` +
					`members: ${starvedMembers.map(m => m.name).join(', ')}`);

				const result = await runCycle({
					membersWithWork: starvedMembers, priority: starved, cycleCount,
					opts, teamDir, logsDir, version, repoRoot, startTime, useTimeout,
				});
				totalMemberRuns += result.memberRuns;
				if (result.lastError) passErrors.push(result.lastError);
				lastServedAt[starved] = Date.now();

				if (result.stopped) return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
				continue;
			}
		}

		const priorityIdx = PRIORITY_ORDER.indexOf(currentPriority);

		if (isBudgetExhausted(currentPriority)) {
			if (priorityIdx < PRIORITY_ORDER.length - 1) {
				console.log(`\n[runner] Budget exhausted for "${currentPriority}" (${opts.budgets[currentPriority]} cycle(s)), advancing.`);
				currentPriority = PRIORITY_ORDER[priorityIdx + 1];
				continue;
			}
			console.log(`\n[runner] Budget exhausted for "${currentPriority}" — all priorities done.`);
			break;
		}

		// Min-interval gate: skip priorities served too recently (work-week cadence)
		const minInterval = opts.minIntervals[currentPriority];
		if (minInterval) {
			const elapsed = Date.now() - (lastServedAt[currentPriority] ?? 0);
			if (elapsed < minInterval) {
				const remainH = Math.round((minInterval - elapsed) / 3600000);
				if (priorityIdx < PRIORITY_ORDER.length - 1) {
					console.log(`\n[runner] Priority "${currentPriority}" on cooldown (${remainH}h remaining), advancing.`);
					currentPriority = PRIORITY_ORDER[priorityIdx + 1];
					continue;
				}
				console.log(`\n[runner] Priority "${currentPriority}" on cooldown (${remainH}h remaining) — all priorities done.`);
				break;
			}
		}

		let membersWithWork = await getMembersWithWork(members, currentPriority, teamDir);

		if (membersWithWork.length === 0) {
			if (priorityIdx < PRIORITY_ORDER.length - 1) {
				const prev = currentPriority;
				currentPriority = PRIORITY_ORDER[priorityIdx + 1];
				console.log(`\n[runner] No work at "${prev}", advancing to "${currentPriority}"`);
				continue;
			}
			console.log('\n[runner] All priorities processed.');
			break;
		}

		// Rotate for round-robin fairness, then trim to remaining budget
		const cap = opts.budgets[currentPriority];
		if (cap != null) {
			membersWithWork = rotateAfter(membersWithWork, lastServedMember[currentPriority]);
			const remaining = cap - (budgetSpent[currentPriority] ?? 0);
			if (membersWithWork.length > remaining) {
				membersWithWork = membersWithWork.slice(0, remaining);
			}
		}

		cycleCount++;
		console.log(`\n[runner] Cycle ${cycleCount}, priority: ${currentPriority}, ` +
			`members: ${membersWithWork.map(m => m.name).join(', ')}`);

		const result = await runCycle({
			membersWithWork, priority: currentPriority, cycleCount,
			opts, teamDir, logsDir, version, repoRoot, startTime, useTimeout,
		});
		totalMemberRuns += result.memberRuns;
		if (result.lastError) passErrors.push(result.lastError);
		budgetSpent[currentPriority] = (budgetSpent[currentPriority] ?? 0) + result.memberRuns;
		if (membersWithWork.length > 0) {
			lastServedMember[currentPriority] = membersWithWork[membersWithWork.length - 1].name;
		}
		lastServedAt[currentPriority] = Date.now();

		if (result.stopped) return { cycleCount, totalMemberRuns, stopped: true, timedOut: false, passErrors };
	}

	return { cycleCount, totalMemberRuns, stopped: false, timedOut: false, passErrors };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	const repoRoot = process.cwd();
	const teamDir = join(repoRoot, 'team');
	const version = getVersion();

	if (!await pathExists(teamDir)) {
		console.error('team/ directory not found. Run `node teamos/scripts/init.mjs` first.');
		process.exit(1);
	}

	// Validate agent is available
	try {
		await validateAgent(opts.agent);
	} catch (err) {
		console.error(`[runner] ${err.message}`);
		process.exit(1);
	}

	// Start opencode server for persistent authentication (if using opencode)
	let serverUrl = null;
	if (opts.agent === 'opencode') {
		serverUrl = await startOpenCodeServer(repoRoot);
	}

	// Ensure server is stopped on exit
	process.on('exit', () => stopOpenCodeServer());
	process.on('SIGINT', async () => {
		await stopOpenCodeServer();
		process.exit(128 + 2);
	});
	process.on('SIGTERM', async () => {
		await stopOpenCodeServer();
		process.exit(128 + 15);
	});

	const allMembers = await loadMembers(teamDir);
	const members = opts.member
		? allMembers.filter(m => m.name === opts.member)
		: allMembers;

	if (members.length === 0) {
		console.log(opts.member
			? `Member "${opts.member}" not found or not active.`
			: 'No active AI members found in team/members.json.');
		return;
	}

	// ── Ensure recurring system events ────────────────────────────────────────

	await ensureSelfAssessmentEvents(allMembers, teamDir);

	// ── Clerk only ────────────────────────────────────────────────────────────

	if (opts.clerkOnly) {
		console.log(`\nteamos (${version}) — clerk only`);
		const logsDir = await ensureLogsDir(teamDir);
		const clerkLog = buildLogPath(logsDir, 'clerk', 'manual');

		await writeFile(clerkLog, [
			`Clerk run (manual)`,
			`Agent: ${opts.agent}`,
			`TeamOS: ${version}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const clerkPrompt = await buildClerkPrompt(teamDir, null);
		const clerkExit = await runAgent(opts.agent, clerkPrompt, repoRoot, clerkLog, serverUrl);

		if (clerkExit !== 0) {
			console.error(`[runner] Clerk exited with code ${clerkExit}`);
		}

		if (!opts.noCommit) {
			if (commitChanges('clerk: manual', repoRoot)) {
				console.log('  Clerk committed.');
				if (opts.push) pushChanges(repoRoot);
			}
		}

		console.log('\nDone — clerk only.');
		return;
	}

	// ── Dry run ────────────────────────────────────────────────────────────────

	if (opts.dryRun) {
		console.log(`\nteamos (${version})`);
		console.log(`Active AI members: ${members.map(m => m.name).join(', ')}\n`);

		for (const priority of PRIORITY_ORDER) {
			const withWork = await getMembersWithWork(members, priority, teamDir);
			if (withWork.length > 0) {
				console.log(`  [${priority}]`);
				for (const m of withWork) {
					console.log(`    ${m.name} (${m.title})`);
				}
			}
		}

		console.log();
		return;
	}

	// ── Run ────────────────────────────────────────────────────────────────────

	const budgetStr = Object.entries(opts.budgets)
		.map(([p, n]) => `${p}:${n}`)
		.join(', ');
	const intervalStr = Object.entries(opts.minIntervals)
		.map(([p, ms]) => `${p}:${Math.round(ms / 86400000)}d`)
		.join(', ');
	const banner = [
		'═'.repeat(72),
		`  teamos (${version})${opts.loop ? ' [loop mode]' : ''}`,
		`  ${members.length} active AI member(s): ${members.map(m => m.name).join(', ')}`,
		`  Starting priority: ${opts.priority}`,
		budgetStr ? `  Budgets: ${budgetStr}` : null,
		intervalStr ? `  Min intervals: ${intervalStr}` : null,
		opts.loop ? `  Interval: ${opts.intervalMs / 60000}min` : null,
		'═'.repeat(72),
	].filter(Boolean).join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(teamDir);
	const schedulerState = await loadSchedulerState(logsDir);

	if (opts.loop) {
		let passNum = 0;

		while (true) {
			if (await checkStop(teamDir)) {
				console.log('\n[runner] Stop file detected — exiting loop.');
				break;
			}

			passNum++;
			const passStart = Date.now();
			console.log(`\n${'═'.repeat(72)}`);
			console.log(`  Pass ${passNum} started at ${new Date().toISOString()}`);
			console.log('═'.repeat(72));

			const result = await runPass({
				opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
				useTimeout: false, opencodeServerUrl: serverUrl,
			});


			// Post-pass maintenance: housekeeping, conditional clerk, weekly efficiency analysis
			if (!result.stopped) {
				await runMaintenance({
					opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
					passErrors: result.passErrors, opencodeServerUrl: serverUrl,
				});
			}
			console.log(`\n[runner] Pass ${passNum} complete — ${result.cycleCount} cycle(s), ${result.totalMemberRuns} member run(s).`);
			await saveSchedulerState(logsDir, schedulerState);

			if (result.stopped) {
				console.log('[runner] Stop file detected — exiting loop.');
				break;
			}

			const elapsed = Date.now() - passStart;
			const remaining = opts.intervalMs - elapsed;

			if (remaining > 0) {
				const mins = Math.round(remaining / 60000);
				console.log(`[runner] Idle for ~${mins}min until next interval.`);
				const reason = await idleWait(remaining, teamDir, members);
				if (reason === 'stop') {
					console.log('\n[runner] Stop file detected — exiting loop.');
					break;
				}
				if (reason === 'work') {
					console.log('[runner] New work detected — starting next pass early.');
				}
			} else {
				console.log(`[runner] Pass took ${Math.round(elapsed / 60000)}min (overran interval) — starting next pass.`);
			}
		}

		console.log('\nTeamOS loop ended.');
	} else {
		const result = await runPass({
			opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
			useTimeout: true, opencodeServerUrl: serverUrl,
		});

		await runMaintenance({
			opts, teamDir, logsDir, version, repoRoot, members, schedulerState,
			passErrors: result.passErrors, opencodeServerUrl: serverUrl,
		});

		await saveSchedulerState(logsDir, schedulerState);

		if (result.cycleCount >= opts.maxCycles) {
			console.log(`\n[runner] Reached max cycles (${opts.maxCycles}).`);
		}
		if (result.timedOut) {
			console.log(`[runner] Reached time limit (${MAX_RUN_MS / 60000}min).`);
		}

		console.log(`\nDone — ${result.cycleCount} cycle(s), ${result.totalMemberRuns} member run(s).`);
	}
}

main().catch((err) => {
	console.error('TeamOS runner failed:', err);
	process.exit(1);
});
