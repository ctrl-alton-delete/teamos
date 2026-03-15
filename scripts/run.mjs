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
 *   --agent <name>       Agent adapter: claude | auggie | cursor  (default: claude)
 *   --priority <level>   Starting priority: pressing | today | thisWeek | later
 *                                                                (default: pressing)
 *   --member <name>      Only run cycles for a specific member
 *   --max-cycles <n>     Max cycle passes before stopping         (default: 10)
 *   --no-commit          Skip automatic git commit after each cycle
 *   --no-clerk           Skip clerk agent after each pass
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
const MAX_RUN_MS = 60 * 60 * 1000;      // 1 hour hard stop

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
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function pathExists(filePath) {
	try { await access(filePath, constants.R_OK); return true; } catch { return false; }
}

async function readTextOrEmpty(filePath) {
	try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
}

// ─── Member discovery ──────────────────────────────────────────────────────────

async function loadMembers(teamDir) {
	const content = await readFile(join(teamDir, 'members.json'), 'utf-8');
	const manifest = JSON.parse(content);
	return manifest.members
		.filter(m => m.active && m.type === 'ai')
		.sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

// ─── Work detection ────────────────────────────────────────────────────────────

async function memberHasWork(memberName, priority, teamDir) {
	const memberDir = join(teamDir, 'members', memberName);

	// Check inbox for messages
	const inboxDir = join(memberDir, 'inbox');
	if (await pathExists(inboxDir)) {
		try {
			const files = await readdir(inboxDir);
			if (files.some(f => f.endsWith('.json'))) return true;
		} catch { /* ignore */ }
	}

	// Check todos at this priority or higher
	const todoPath = join(memberDir, 'todo.json');
	if (await pathExists(todoPath)) {
		try {
			const todos = JSON.parse(await readFile(todoPath, 'utf-8'));
			const priorityIdx = PRIORITY_ORDER.indexOf(priority);
			if (todos.items.some(t => PRIORITY_ORDER.indexOf(t.priority) <= priorityIdx)) return true;
		} catch { /* ignore */ }
	}

	// Check schedule for due events
	const schedulePath = join(memberDir, 'schedule.json');
	if (await pathExists(schedulePath)) {
		try {
			const schedule = JSON.parse(await readFile(schedulePath, 'utf-8'));
			const now = new Date();
			if (schedule.events.some(e => new Date(e.time) <= now)) return true;
		} catch { /* ignore */ }
	}

	return false;
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
		const jsonFiles = files.filter(f => f.endsWith('.json'));
		const messages = [];
		for (const file of jsonFiles) {
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
	const systemFile = join(TEAMOS_ROOT, 'README.md');

	const [rules, systemDoc, orgDoc, newsDoc, projectsDoc, membersDoc,
		profile, state, todos, schedule] = await Promise.all([
		readTextOrEmpty(rulesFile),
		readTextOrEmpty(systemFile),
		readTextOrEmpty(join(teamDir, 'org.md')),
		readTextOrEmpty(join(teamDir, 'news.json')),
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
		`# Time: ${new Date().toISOString()}`,
		`# Team directory: team/`,
		`# Member directory: team/members/${member.name}/`,
		'',
		'## System Architecture',
		'',
		systemDoc,
		'',
		'## Cycle Rules',
		'',
		rules,
		'',
		'## Organization',
		'',
		orgDoc,
		'',
		'## News',
		'',
		newsDoc,
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
		'## Instructions',
		'',
		`Execute a cycle for **${member.name}** at priority level **${priority}**.`,
		'Follow the cycle rules above.',
		'Do NOT commit — the runner handles commits after you complete.',
	);

	return parts.join('\n');
}

async function buildClerkPrompt(teamDir, error) {
	const clerkRules = await readTextOrEmpty(join(TEAMOS_ROOT, 'agent-rules', 'clerk.md'));
	const systemDoc = await readTextOrEmpty(join(TEAMOS_ROOT, 'README.md'));

	const parts = [
		'# TeamOS Clerk',
		`# Time: ${new Date().toISOString()}`,
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

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code. */
async function runAgent(agentName, prompt, cwd, logFile) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	const adapterResult = adapter(instructionFile, prompt, { cwd });
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
		'  --agent <name>       claude | auggie | cursor              (default: claude)',
		'  --priority <level>   Starting priority level               (default: pressing)',
		'  --member <name>      Only run cycles for a specific member',
		'  --max-cycles <n>     Max cycle passes                      (default: 10)',
		'  --no-commit          Skip automatic git commit after each cycle',
		'  --no-clerk           Skip clerk agent after each pass',
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
		noCommit: false,
		noClerk: false,
		dryRun: false,
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
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--no-clerk':
				opts.noClerk = true;
				break;
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

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	const repoRoot = process.cwd();
	const teamDir = join(repoRoot, 'team');
	const version = getVersion();

	// Verify team/ exists
	if (!await pathExists(teamDir)) {
		console.error('team/ directory not found. Run `node teamos/scripts/init.mjs` first.');
		process.exit(1);
	}

	// Load members
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

	const banner = [
		`${'═'.repeat(72)}`,
		`  teamos (${version})`,
		`  ${members.length} active AI member(s): ${members.map(m => m.name).join(', ')}`,
		`  Starting priority: ${opts.priority}`,
		`${'═'.repeat(72)}`,
	].join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(teamDir);
	const startTime = Date.now();
	let currentPriority = opts.priority;
	let cycleCount = 0;
	let totalMemberRuns = 0;

	while (cycleCount < opts.maxCycles && (Date.now() - startTime) < MAX_RUN_MS) {
		const priorityIdx = PRIORITY_ORDER.indexOf(currentPriority);
		const membersWithWork = await getMembersWithWork(members, currentPriority, teamDir);

		if (membersWithWork.length === 0) {
			// Advance to next priority level
			if (priorityIdx < PRIORITY_ORDER.length - 1) {
				const prev = currentPriority;
				currentPriority = PRIORITY_ORDER[priorityIdx + 1];
				console.log(`\n[runner] No work at "${prev}", advancing to "${currentPriority}"`);
				continue;
			}
			console.log('\n[runner] All priorities processed.');
			break;
		}

		cycleCount++;
		console.log(`\n[runner] Cycle ${cycleCount}, priority: ${currentPriority}, ` +
			`members: ${membersWithWork.map(m => m.name).join(', ')}`);

		let lastError = null;

		for (const member of membersWithWork) {
			if ((Date.now() - startTime) >= MAX_RUN_MS) {
				console.log('\n[runner] Time limit reached.');
				break;
			}

			totalMemberRuns++;
			const currentLog = buildLogPath(logsDir, member.name, currentPriority);

			const memberBanner = [
				`${'─'.repeat(72)}`,
				`  ${member.name} (${member.title})`,
				`  Priority: ${currentPriority}  |  Cycle: ${cycleCount}`,
				`  Log: ${currentLog}`,
				`${'─'.repeat(72)}`,
			].join('\n');
			console.log(memberBanner);

			// Write log header
			await writeFile(currentLog, [
				`Member: ${member.name} (${member.title})`,
				`Priority: ${currentPriority}`,
				`Agent: ${opts.agent}`,
				`TeamOS: ${version}`,
				`Started: ${new Date().toISOString()}`,
				'═'.repeat(72),
				'',
			].join('\n'));

			const prompt = await buildCyclePrompt(member, currentPriority, teamDir);
			const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog);

			if (exitCode !== 0) {
				lastError = `Agent exited with code ${exitCode} for member: ${member.name}`;
				console.error(`\n${lastError}`);
				console.error(`Log: ${currentLog}`);
			}

			if (!opts.noCommit) {
				const label = `cycle(${member.name}): ${currentPriority}`;
				if (commitChanges(label, repoRoot)) {
					console.log('  Committed.');
				}
			}

			console.log(`\n  Complete: ${member.name}\n`);

			// Brief pause between members
			if (membersWithWork.indexOf(member) < membersWithWork.length - 1) {
				await new Promise(r => setTimeout(r, 500));
			}
		}

		// Run clerk for cleanup
		if (!opts.noClerk) {
			console.log('\n[runner] Running clerk...');
			const clerkLog = buildLogPath(logsDir, 'clerk', currentPriority);

			await writeFile(clerkLog, [
				`Clerk run after cycle ${cycleCount}`,
				`Priority: ${currentPriority}`,
				`Agent: ${opts.agent}`,
				`TeamOS: ${version}`,
				`Started: ${new Date().toISOString()}`,
				lastError ? `Error: ${lastError}` : 'No errors.',
				'═'.repeat(72),
				'',
			].join('\n'));

			const clerkPrompt = await buildClerkPrompt(teamDir, lastError);
			const clerkExit = await runAgent(opts.agent, clerkPrompt, repoRoot, clerkLog);

			if (clerkExit !== 0) {
				console.error(`[runner] Clerk exited with code ${clerkExit}`);
			}

			if (!opts.noCommit) {
				if (commitChanges(`clerk: cycle ${cycleCount} (${currentPriority})`, repoRoot)) {
					console.log('  Clerk committed.');
				}
			}
		}
	}

	if (cycleCount >= opts.maxCycles) {
		console.log(`\n[runner] Reached max cycles (${opts.maxCycles}).`);
	}
	if ((Date.now() - startTime) >= MAX_RUN_MS) {
		console.log(`[runner] Reached time limit (${MAX_RUN_MS / 60000}min).`);
	}

	console.log(`\nDone — ${cycleCount} cycle(s), ${totalMemberRuns} member run(s).`);
}

main().catch((err) => {
	console.error('TeamOS runner failed:', err);
	process.exit(1);
});
