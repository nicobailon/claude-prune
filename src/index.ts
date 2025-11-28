#!/usr/bin/env node
import { homedir } from "os";
import { join } from "path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm, select } from "@clack/prompts";
import { spawn, ChildProcess } from "child_process";
import { createSummaryProgress } from "./progress.js";
import { formatOriginalStats, formatResultStats, countMessageTypes, displayCelebration } from "./stats.js";

// Track active child process for cleanup on signals
let activeChild: ChildProcess | null = null;

const cleanupChild = () => {
  const child = activeChild;
  if (child && !child.killed) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }
    }, 2000);
  }
};

process.on('SIGINT', () => {
  console.log(chalk.yellow('\nInterrupted. Cleaning up...'));
  cleanupChild();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanupChild();
  process.exit(143);
});

// ---------- Helper Functions ----------
export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function extractMessageContent(content: unknown): string {
  if (!content) return '';

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';

        const obj = item as Record<string, unknown>;

        if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
        if (typeof obj.text === 'string' && !obj.type) return obj.text;

        if (obj.type === 'tool_result') {
          if (typeof obj.content === 'string') return obj.content;
          if (Array.isArray(obj.content)) {
            return (obj.content as Array<Record<string, unknown>>)
              .map((c) => (typeof c.text === 'string' ? c.text : ''))
              .join('\n');
          }
        }

        if (obj.type === 'thinking' && typeof obj.thinking === 'string') return obj.thinking;

        if (obj.type === 'tool_use' && typeof obj.name === 'string') return `[Used tool: ${obj.name}]`;

        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  return '';
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionInfo {
  id: string;
  path: string;
  modifiedAt: Date;
  sizeKB: number;
}

export async function listSessions(projectDir: string): Promise<SessionInfo[]> {
  if (!(await fs.pathExists(projectDir))) {
    return [];
  }

  const files = await fs.readdir(projectDir);
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.replace('.jsonl', '');
    if (!UUID_PATTERN.test(id)) continue;

    const filePath = join(projectDir, file);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const hasConversation = content.includes('"type":"user"') ||
                              content.includes('"type":"assistant"');
      if (!hasConversation) continue;

      const stat = await fs.stat(filePath);
      sessions.push({
        id,
        path: filePath,
        modifiedAt: stat.mtime,
        sizeKB: Math.round(stat.size / 1024)
      });
    } catch {
      continue;
    }
  }

  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export async function findLatestSession(projectDir: string): Promise<SessionInfo | null> {
  const sessions = await listSessions(projectDir);
  return sessions.length > 0 ? sessions[0] : null;
}

export function getProjectDir(): string {
  const cwdProject = process.cwd().replace(/\//g, '-');
  return join(getClaudeConfigDir(), "projects", cwdProject);
}

// ---------- CLI Definition ----------
const program = new Command()
  .name("ccprune")
  .description("Prune early messages from a Claude Code session.jsonl file")
  .version("2.3.1");

program
  .command("prune")
  .description("Prune early messages from a session (summarizes by default)")
  .argument("[sessionId]", "UUID of the session (auto-detects latest if omitted)")
  .option("-k, --keep <number>", "number of assistant messages to keep", parseInt)
  .option("-p, --keep-percent <number>", "percentage of assistant messages to keep (1-100)", parseInt)
  .option("--pick", "interactively select from available sessions")
  .option("-n, --no-resume", "skip automatic session resume")
  .option("--dry-run", "preview changes without writing (still generates summary preview)")
  .option("--no-summary", "skip AI summarization of pruned messages")
  .option("--summary-model <model>", "model for summarization (haiku, sonnet, or full name)")
  .option("--summary-timeout <ms>", "max total time for summarization in ms (default: 360000)", parseInt)
  .option("--gemini", "use Gemini 3 Pro for summarization (requires GEMINI_API_KEY)")
  .option("--gemini-flash", "use Gemini 2.5 Flash for summarization (requires GEMINI_API_KEY)")
  .action(function(sessionId) {
    return pruneCommand(sessionId, this.opts());
  });

program
  .command("restore")
  .description("Restore a session from the latest backup")
  .argument("<sessionId>", "UUID of the session to restore (without .jsonl)")
  .option("--dry-run", "show what would be restored but don't write")
  .action(restore);

// For backward compatibility, make prune the default command
program
  .argument("[sessionId]", "UUID of the session (auto-detects latest if omitted)")
  .option("-k, --keep <number>", "number of assistant messages to keep", parseInt)
  .option("-p, --keep-percent <number>", "percentage of assistant messages to keep (1-100)", parseInt)
  .option("--pick", "interactively select from available sessions")
  .option("-n, --no-resume", "skip automatic session resume")
  .option("--dry-run", "preview changes without writing (still generates summary preview)")
  .option("--no-summary", "skip AI summarization of pruned messages")
  .option("--summary-model <model>", "model for summarization (haiku, sonnet, or full name)")
  .option("--summary-timeout <ms>", "max total time for summarization in ms (default: 360000)", parseInt)
  .option("--gemini", "use Gemini 3 Pro for summarization (requires GEMINI_API_KEY)")
  .option("--gemini-flash", "use Gemini 2.5 Flash for summarization (requires GEMINI_API_KEY)")
  .action(function(sessionId) {
    return pruneCommand(sessionId, this.opts());
  });

// Count assistant messages (for percentage calculation)
export function countAssistantMessages(lines: string[]): number {
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    try {
      const { type } = JSON.parse(lines[i]);
      if (type === 'assistant') count++;
    } catch { /* skip non-JSON */ }
  }
  return count;
}

// Extract core logic for testing
export function pruneSessionLines(lines: string[], keepN: number): { outLines: string[], kept: number, dropped: number, assistantCount: number, droppedMessages: { type: string, content: string, isSummary?: boolean }[] } {
  // Define message types to track and prune. Tool results and other lines are always kept.
  const MSG_TYPES = new Set(["user", "assistant", "system"]);
  const msgIndexes: number[] = [];
  const assistantIndexes: number[] = [];

  // Pass 1 – locate message objects (skip first line entirely)
  lines.forEach((ln, i) => {
    if (i === 0) return; // Always preserve first item
    try {
      const { type } = JSON.parse(ln);
      if (MSG_TYPES.has(type)) {
        msgIndexes.push(i);
        if (type === "assistant") {
          assistantIndexes.push(i);
        }
      }
    } catch { /* non-JSON diagnostic line – keep as-is */ }
  });

  const keepNSafe = Math.max(0, keepN);

  // Find the cutoff point based on last N assistant messages
  // cutFrom = Infinity means drop all messages (keepN=0 case)
  // cutFrom = 0 means keep all messages (keepN >= assistantCount case)
  let cutFrom: number = 0;
  if (keepNSafe === 0) {
    cutFrom = Infinity; // Drop all messages
  } else if (assistantIndexes.length > keepNSafe) {
    cutFrom = assistantIndexes[assistantIndexes.length - keepNSafe];
  }

  // Pass 2 – build pruned output
  const outLines: string[] = [];
  let kept = 0;
  let dropped = 0;
  const droppedMessages: { type: string, content: string, isSummary?: boolean }[] = [];

  // Always include first line
  if (lines.length > 0) {
    outLines.push(lines[0]);
  }

  // HACK: Zero out ONLY the last non-zero cache_read_input_tokens to trick UI percentage
  let lastNonZeroCacheLineIndex = -1;

  // First pass: find the last non-zero cache line
  lines.forEach((ln, i) => {
    try {
      const obj = JSON.parse(ln);
      const usageObj = obj.usage || obj.message?.usage;
      if (usageObj?.cache_read_input_tokens && usageObj.cache_read_input_tokens > 0) {
        lastNonZeroCacheLineIndex = i;
      }
    } catch { /* not JSON, skip */ }
  });

  // Second pass: process lines and zero out only the last non-zero cache line
  const processedLines = lines.map((ln, i) => {
    if (i === lastNonZeroCacheLineIndex) {
      try {
        const obj = JSON.parse(ln);
        const usageObj = obj.usage || obj.message?.usage;
        usageObj.cache_read_input_tokens = 0;
        return JSON.stringify(obj);
      } catch { /* should not happen since we found it in first pass */ }
    }
    return ln;
  });

  processedLines.forEach((ln, idx) => {
    if (idx === 0) return; // Already added above
    
    let parsedObj: any = null;
    let objType = "";
    try {
      parsedObj = JSON.parse(ln);
      objType = parsedObj.type || "";
    } catch { 
      // Not JSON, keep as-is
      outLines.push(ln);
      return;
    }
    
    const isMsg = MSG_TYPES.has(objType);
    if (isMsg) {
      if (idx >= cutFrom) { 
        kept++; 
        outLines.push(ln); 
      } else {
        dropped++;
        const { type, message, isCompactSummary } = parsedObj;
        if (message?.content !== undefined) {
          const contentStr = extractMessageContent(message.content);
          droppedMessages.push({ type, content: contentStr, isSummary: isCompactSummary === true });
        }
      }
    } else {
      outLines.push(ln); // always keep tool lines, etc.
    }
  });

  return { outLines, kept, dropped, assistantCount: assistantIndexes.length, droppedMessages };
}

// Only run CLI if not in test environment
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  program.parse();
}

// Helper to get message type label
function getMessageTypeLabel(type: string): string {
  if (type === 'user') return 'User';
  if (type === 'system') return 'System';
  return 'Assistant';
}

async function spawnClaudeAsync(
  args: string[],
  input: string,
  timeoutMs: number,
  onTick?: () => void,
  onSpawn?: (child: ChildProcess) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Allow parent to track this child for cleanup
    onSpawn?.(child);

    const tickInterval = onTick ? setInterval(() => {
      onTick();
    }, 1000) : null;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimeoutId = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle stdin errors (pipe closed early, etc.)
    child.stdin?.on('error', (err) => {
      clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      if (tickInterval) clearInterval(tickInterval);
      child.kill('SIGTERM');
      reject(new Error(`Failed to write to Claude stdin: ${err.message}`));
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      if (tickInterval) clearInterval(tickInterval);
      if (err.code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Make sure Claude Code is installed and the "claude" command is available.'));
      } else {
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      if (tickInterval) clearInterval(tickInterval);

      if (timedOut) {
        const sizeKB = Math.round(input.length / 1024);
        reject(new Error(
          `Summary generation timed out after ${timeoutMs / 1000}s (transcript: ${sizeKB}KB). ` +
          `Try: --summary-model haiku (faster) or --summary-timeout 600000 (10 min)`
        ));
      } else if (signal) {
        reject(new Error(`Claude CLI was killed by signal ${signal}: ${stderr}`));
      } else if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

// Chunking constants
const CHUNK_SIZE = 30000;
const MAX_SINGLE_PASS = 30000;

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.substring(0, chunkSize);
    const lastNewline = slice.lastIndexOf('\n');
    const cutPoint = lastNewline > chunkSize * 0.8 ? lastNewline : chunkSize;

    chunks.push(remaining.substring(0, cutPoint));
    remaining = remaining.substring(cutPoint);
  }
  return chunks;
}

async function summarizeChunk(
  chunk: string,
  chunkNum: number,
  totalChunks: number,
  options: { model?: string; timeout?: number; onProgress?: () => void }
): Promise<string> {
  const prompt = `Summarize this conversation segment (part ${chunkNum} of ${totalChunks}).
Focus on: key decisions, files modified, problems solved, current state.
Be concise but preserve important technical details.

${chunk}`;

  const args = ['-p'];
  if (options.model) {
    args.push('--model', options.model);
  }

  return await spawnClaudeAsync(args, prompt, options.timeout || 180000, options.onProgress, (child) => {
    activeChild = child;
  });
}

async function combineSummaries(
  summaries: string[],
  options: { model?: string; timeout?: number; onProgress?: () => void }
): Promise<string> {
  const combined = summaries.map((s, i) => `=== Part ${i + 1} ===\n${s}`).join('\n\n');

  const prompt = `Combine these ${summaries.length} partial summaries into a single coherent summary.
Start with "Previously, we discussed..." and organize into:
1. Overview (1-2 sentences)
2. What Was Accomplished
3. Files Modified
4. Key Technical Details
5. Current State & Pending Work

${combined}`;

  const args = ['-p'];
  if (options.model) {
    args.push('--model', options.model);
  }

  const result = await spawnClaudeAsync(args, prompt, options.timeout || 180000, options.onProgress, (child) => {
    activeChild = child;
  });
  return result.trim();
}

async function generateSummaryWithGemini(
  prompt: string,
  options: { useFlash?: boolean; onProgress?: () => void }
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required when using --gemini');
  }

  const model = options.useFlash ? 'gemini-2.5-flash' : 'gemini-3-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const progressInterval = options.onProgress
    ? setInterval(options.onProgress, 500)
    : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error('Gemini API returned empty response');
    }

    return text.trim();
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
    }
  }
}

// Extract summarization logic for testing
export async function generateSummary(
  droppedMessages: { type: string, content: string, isSummary?: boolean }[],
  options: { maxLength?: number; model?: string; timeout?: number; onProgress?: () => void; useGemini?: boolean; useGeminiFlash?: boolean } = {}
): Promise<string> {
  const maxLength = options.maxLength || MAX_SINGLE_PASS;

  // Separate existing summary from chat messages for synthesis
  const existingSummary = droppedMessages.find(m => m.isSummary);
  const chatMessages = droppedMessages.filter(m => !m.isSummary);

  // If only summary is being dropped (no chat messages), return it unchanged
  if (existingSummary && chatMessages.length === 0) {
    return existingSummary.content;
  }

  let transcriptToSummarize = chatMessages
    .map(msg => `${getMessageTypeLabel(msg.type)}: ${msg.content}`)
    .join('\n\n');

  // For very large transcripts, use chunked summarization (Claude only - Gemini handles large context)
  if (!options.useGemini && transcriptToSummarize.length > maxLength) {
    console.log(chalk.yellow(`\nTranscript very large (${Math.round(transcriptToSummarize.length / 1024)}KB). Summarizing in chunks...`));

    const chunkSize = Math.min(CHUNK_SIZE, maxLength);
    const chunks = splitIntoChunks(transcriptToSummarize, chunkSize);
    const chunkSummaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(chalk.dim(`  Chunk ${i + 1}/${chunks.length}...`));
      const chunkSummary = await summarizeChunk(chunks[i], i + 1, chunks.length, options);
      chunkSummaries.push(chunkSummary);
    }

    // If there's an existing summary, include it in the combination
    if (existingSummary) {
      chunkSummaries.unshift(`=== Previous Summary ===\n${existingSummary.content}`);
    }

    return await combineSummaries(chunkSummaries, options);
  }

  let prompt: string;
  if (existingSummary) {
    // Synthesis mode: combine old summary + new messages
    prompt = `You have an existing summary of earlier work, followed by a more recent conversation that needs to be incorporated. Create a unified comprehensive summary.

## Instructions
1. Preserve critical context from the existing summary that remains relevant
2. Integrate new accomplishments, decisions, and file changes from the recent conversation
3. Update the "Current State & Pending Work" section to reflect the latest status
4. Remove outdated details that are no longer relevant
5. Maintain the structured format with all sections

## Existing Summary:
${existingSummary.content}

## Recent Conversation to Incorporate:
${transcriptToSummarize}

Produce a single cohesive summary that starts with "Previously, we discussed..." and follows the standard section format (Overview, What Was Accomplished, Files Modified, Key Technical Details, Current State & Pending Work).`;
  } else {
    // Fresh summary (no existing summary)
    prompt = `You are summarizing a coding conversation that is being pruned to reduce context. Create a comprehensive structured summary that preserves essential information for continuing the work seamlessly.

Analyze the transcript and produce a summary with these sections:

## 1. Overview
Start with "Previously, we discussed..." and provide a high-level summary of the conversation goals and context.

## 2. What Was Accomplished
- Concrete outcomes and changes made
- Decisions finalized
- Problems solved

## 3. Files Modified or Examined
List each file with a brief note on what was done:
- \`path/to/file.ts\` - description of changes or why it was examined

## 4. Key Technical Details
Important patterns, conventions, architectural decisions, or technical context needed to continue:
- Include brief code snippets ONLY for critical patterns or non-obvious implementations
- Note any established conventions or constraints

## 5. Current State & Pending Work
- What was being worked on immediately before this summary
- Any incomplete tasks or planned next steps
- Outstanding issues or blockers

## Format Guidelines
- Be comprehensive - this summary replaces the pruned conversation
- Include specific file paths, function names, and line numbers where relevant
- For code snippets, only include what's essential to understand the pattern (not full implementations)
- If the task evolved during the conversation, note the progression

Here is the transcript to summarize:

${transcriptToSummarize}`;
  }

  // Use Gemini API if requested - no chunking needed
  if (options.useGemini) {
    return await generateSummaryWithGemini(prompt, {
      useFlash: options.useGeminiFlash,
      onProgress: options.onProgress
    });
  }

  const args = ['-p'];
  if (options.model) {
    args.push('--model', options.model);
  }

  const timeout = options.timeout || 360000;
  const summaryContent = await spawnClaudeAsync(args, prompt, timeout, options.onProgress, (child) => {
    activeChild = child;
  });
  return summaryContent.trim();
}

// ---------- Prune Command Wrapper ----------
async function pruneCommand(
  sessionId: string | undefined,
  opts: { keep?: number; keepPercent?: number; pick?: boolean; resume?: boolean; dryRun?: boolean; summary?: boolean; summaryModel?: string; summaryTimeout?: number; gemini?: boolean; geminiFlash?: boolean }
) {
  // --gemini-flash implies --gemini
  if (opts.geminiFlash) {
    opts.gemini = true;
  }

  // Validate Gemini options early
  if (opts.gemini && !process.env.GEMINI_API_KEY) {
    console.error(chalk.red('Error: GEMINI_API_KEY environment variable is required when using --gemini'));
    console.error(chalk.dim('Set it in your shell or .env file: export GEMINI_API_KEY=your_key'));
    process.exit(1);
  }

  const projectDir = getProjectDir();

  if (opts.pick) {
    const sessions = await listSessions(projectDir);
    if (sessions.length === 0) {
      console.error(chalk.red(`No sessions found in ${projectDir}`));
      process.exit(1);
    }

    const selected = await select({
      message: 'Select a session to prune:',
      options: sessions.map(s => ({
        value: s.id,
        label: `${s.id.slice(0, 8)}...`,
        hint: `${s.sizeKB}KB - ${s.modifiedAt.toLocaleString()}`
      }))
    });

    if (typeof selected !== 'string') {
      process.exit(0);
    }

    sessionId = selected;
  } else if (!sessionId) {
    const latest = await findLatestSession(projectDir);
    if (!latest) {
      console.error(chalk.red(`No sessions found in ${projectDir}`));
      console.error(chalk.dim('Run from your project directory, or use --pick to select a session'));
      process.exit(1);
    }

    console.log();
    console.log(chalk.bold.cyan('SESSION'));
    console.log(chalk.white('  ID: ') + chalk.bold.yellow(latest.id));
    console.log(chalk.white('  Modified: ') + chalk.dim(latest.modifiedAt.toLocaleString()));
    console.log(chalk.white('  Size: ') + chalk.dim(`${latest.sizeKB}KB`));
    console.log();
    sessionId = latest.id;
  }

  return main(sessionId, opts);
}

// ---------- Main ----------
async function main(sessionId: string, opts: { keep?: number; keepPercent?: number; resume?: boolean; dryRun?: boolean; summary?: boolean; summaryModel?: string; summaryTimeout?: number; gemini?: boolean; geminiFlash?: boolean }) {
  const cwdProject = process.cwd().replace(/\//g, '-');
  const file = join(getClaudeConfigDir(), "projects", cwdProject, `${sessionId}.jsonl`);

  if (!(await fs.pathExists(file))) {
    console.error(chalk.red(`No transcript at ${file}`));
    process.exit(1);
  }

  if (opts.keep !== undefined && isNaN(opts.keep)) {
    console.error(chalk.red('--keep must be a valid number'));
    process.exit(1);
  }

  if (opts.keepPercent !== undefined && (isNaN(opts.keepPercent) || opts.keepPercent < 1 || opts.keepPercent > 100)) {
    console.error(chalk.red('--keep-percent must be a number between 1 and 100'));
    process.exit(1);
  }

  const spinner = ora(`Reading ${file}`).start();
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let keepN = opts.keep;
  let percentInfo = '';
  if (keepN === undefined && opts.keepPercent !== undefined) {
    const totalAssistant = countAssistantMessages(lines);
    keepN = Math.max(1, Math.ceil(totalAssistant * opts.keepPercent / 100));
    percentInfo = ` (${opts.keepPercent}% of ${totalAssistant})`;
  }

  if (keepN === undefined) {
    const totalAssistant = countAssistantMessages(lines);
    keepN = Math.max(1, Math.ceil(totalAssistant * 20 / 100));
    percentInfo = ` (default 20% of ${totalAssistant})`;
  }

  const originalSizeKB = Math.round(raw.length / 1024);
  const msgCounts = countMessageTypes(lines);

  spinner.succeed(`${chalk.green("Scanned")} ${file}`);
  console.log();
  console.log(formatOriginalStats({
    lines: lines.length,
    userMsgs: msgCounts.user,
    assistantMsgs: msgCounts.assistant,
    systemMsgs: msgCounts.system,
    sizeKB: originalSizeKB
  }));
  console.log();

  const { outLines, kept, dropped, droppedMessages } = pruneSessionLines(lines, keepN);
  console.log(chalk.dim(`Keeping ${keepN} assistant messages${percentInfo} (${kept} lines kept, ${dropped} dropped)`));

  // Check if there's an existing summary in the KEPT portion that needs synthesis
  // This happens when the old summary is near the end and falls within the kept range
  const existingSummaryInDropped = droppedMessages.find(m => m.isSummary);
  if (!existingSummaryInDropped) {
    for (let i = 1; i < outLines.length; i++) {
      try {
        const parsed = JSON.parse(outLines[i]);
        if (parsed.isCompactSummary === true && parsed.message?.content) {
          const keptSummaryContent = extractMessageContent(parsed.message.content);
          droppedMessages.unshift({ type: 'user', content: keptSummaryContent, isSummary: true });
          break;
        }
      } catch { /* not JSON */ }
    }
  }

  // Summarization is ON by default (opts.summary is undefined or true)
  // OFF only when explicitly set to false via --no-summary
  const shouldSummarize = opts.summary !== false && droppedMessages.length > 0;

  let summaryContent: string | null = null;
  let summaryDurationSec = 0;
  let summaryGenerated = false;
  if (shouldSummarize) {
    const transcriptSize = Math.round(droppedMessages.reduce((acc, m) => acc + m.content.length, 0) / 1024);

    const progress = createSummaryProgress({
      transcriptKB: transcriptSize,
      model: opts.summaryModel,
      useGemini: opts.gemini,
      useGeminiFlash: opts.geminiFlash
    });

    progress.start();
    const summaryStartTime = Date.now();

    const MAX_SUMMARY_RETRIES = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
      try {
        summaryContent = await generateSummary(droppedMessages, {
          model: opts.summaryModel,
          timeout: opts.summaryTimeout,
          onProgress: () => progress.update(),
          useGemini: opts.gemini,
          useGeminiFlash: opts.geminiFlash
        });
        summaryDurationSec = Math.floor((Date.now() - summaryStartTime) / 1000);
        summaryGenerated = true;
        progress.succeed();
        break;
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_SUMMARY_RETRIES) {
          console.log(chalk.yellow(`\nSummary attempt ${attempt} failed: ${error.message}`));
          console.log(chalk.yellow('Retrying...'));
        }
      }
    }

    if (!summaryContent && lastError) {
      progress.fail(`Failed to generate summary after ${MAX_SUMMARY_RETRIES} attempts`);
      console.error(chalk.red(lastError.message));
      process.exit(1);
    }
  }

  // When --no-summary but existing summary was dropped, preserve it
  const summaryInDropped = droppedMessages.find(m => m.isSummary);
  if (!shouldSummarize && summaryInDropped) {
    summaryContent = summaryInDropped.content;
  }

  // Dry-run: show preview and exit
  if (opts.dryRun) {
    console.log(chalk.cyan("\nDry-run preview:"));
    console.log(chalk.dim(`  Would prune ${dropped} messages, keep ${kept}`));
    if (summaryContent) {
      console.log(chalk.cyan("\nSummary that would be inserted:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(chalk.white(summaryContent));
      console.log(chalk.dim("─".repeat(60)));
      console.log(chalk.dim("(Would be appended to end of session)"));
    }
    console.log(chalk.cyan("\nNo files written."));
    return;
  }

  // Insert summary if generated
  if (summaryContent) {
    // Remove any existing summary from kept lines to avoid duplicates on re-prune
    for (let i = outLines.length - 1; i >= 1; i--) {
      try {
        const parsed = JSON.parse(outLines[i]);
        if (parsed.isCompactSummary === true) {
          outLines.splice(i, 1);
        }
      } catch { /* not JSON */ }
    }

    // Extract context and timestamp from first real message (skip file-history-snapshot if present)
    let sessionContext = { sessionId: '', cwd: '', slug: '', gitBranch: '', version: '2.0.53' };
    let firstMessageTimestamp: string | null = null;

    for (let i = 1; i < outLines.length; i++) {
      try {
        const parsed = JSON.parse(outLines[i]);
        if (parsed.type === 'user' || parsed.type === 'assistant') {
          sessionContext = {
            sessionId: parsed.sessionId || '',
            cwd: parsed.cwd || '',
            slug: parsed.slug || '',
            gitBranch: parsed.gitBranch || '',
            version: parsed.version || '2.0.53'
          };
          firstMessageTimestamp = parsed.timestamp || null;
          break;
        }
      } catch { /* not JSON */ }
    }

    // Use timestamp slightly before first kept message so summary appears first chronologically
    let summaryTimestamp = new Date().toISOString();
    if (firstMessageTimestamp) {
      const firstMsgTime = new Date(firstMessageTimestamp);
      if (!isNaN(firstMsgTime.getTime())) {
        summaryTimestamp = new Date(firstMsgTime.getTime() - 1).toISOString();
      }
    }

    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: summaryContent },
      uuid: generateUUID(),
      timestamp: summaryTimestamp,
      parentUuid: null,
      sessionId: sessionContext.sessionId,
      cwd: sessionContext.cwd,
      slug: sessionContext.slug,
      gitBranch: sessionContext.gitBranch,
      version: sessionContext.version,
      isSidechain: false,
      userType: "external"
    });

    outLines.push(summaryLine);
  }

  const backupDir = join(getClaudeConfigDir(), "projects", cwdProject, "prune-backup");
  await fs.ensureDir(backupDir);
  const backup = join(backupDir, `${sessionId}.jsonl.${Date.now()}`);
  await fs.copyFile(file, backup);

  const finalContent = outLines.join("\n") + "\n";
  await fs.writeFile(file, finalContent);

  const finalSizeKB = Math.round(finalContent.length / 1024);
  const finalAssistantCount = countMessageTypes(outLines).assistant;

  console.log();
  console.log(formatResultStats({
    before: {
      lines: lines.length,
      assistantMsgs: msgCounts.assistant,
      sizeKB: originalSizeKB
    },
    after: {
      lines: outLines.length,
      assistantMsgs: finalAssistantCount,
      sizeKB: finalSizeKB
    },
    summary: summaryGenerated ? {
      sizeKB: Math.round(summaryContent!.length / 1024) || 1,
      durationSec: summaryDurationSec,
      model: opts.summaryModel
    } : undefined,
    backupPath: backup
  }));
  console.log();
  console.log(chalk.bold.green("Done:"), chalk.white(file));

  // Show celebration before auto-resume
  if (process.stdin.isTTY) {
    console.log();
    console.log(displayCelebration({
      sessionId,
      before: {
        lines: lines.length,
        assistantMsgs: msgCounts.assistant,
        sizeKB: originalSizeKB
      },
      after: {
        lines: outLines.length,
        assistantMsgs: finalAssistantCount,
        sizeKB: finalSizeKB
      },
      hasSummary: summaryGenerated || (summaryContent !== null)
    }));

    // Pause for 10 seconds if we're going to resume
    if (opts.resume !== false) {
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  if (process.stdin.isTTY && opts.resume !== false) {
    console.log(chalk.dim(`\nResuming: claude --resume ${sessionId}\n`));
    const child = spawn('claude', ['--resume', sessionId], {
      stdio: 'inherit'
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red('\nClaude CLI not found. Run manually:'));
        console.error(chalk.white(`  claude --resume ${sessionId}`));
      } else {
        console.error(chalk.red(`\nFailed to start claude: ${err.message}`));
      }
      process.exit(1);
    });
    child.on('close', (code) => {
      process.exit(code ?? 0);
    });
    return new Promise<void>(() => {});
  }
}

// Extract restore logic for testing
export function findLatestBackup(backupFiles: string[], sessionId: string): { name: string, timestamp: number } | null {
  const sessionBackups = backupFiles
    .filter(f => f.startsWith(`${sessionId}.jsonl.`))
    .map(f => ({
      name: f,
      timestamp: parseInt(f.split('.').pop() || '0')
    }))
    .filter(backup => !isNaN(backup.timestamp)) // Filter out invalid timestamps
    .sort((a, b) => b.timestamp - a.timestamp);

  return sessionBackups.length > 0 ? sessionBackups[0] : null;
}

// ---------- Restore ----------
async function restore(sessionId: string, opts: { dryRun?: boolean }) {
  const cwdProject = process.cwd().replace(/\//g, '-');
  const file = join(getClaudeConfigDir(), "projects", cwdProject, `${sessionId}.jsonl`);
  const backupDir = join(getClaudeConfigDir(), "projects", cwdProject, "prune-backup");

  if (!(await fs.pathExists(backupDir))) {
    console.error(chalk.red(`No backup directory found at ${backupDir}`));
    process.exit(1);
  }

  const spinner = ora(`Finding latest backup for ${sessionId}`).start();
  
  try {
    const backupFiles = await fs.readdir(backupDir);
    const latestBackup = findLatestBackup(backupFiles, sessionId);

    if (!latestBackup) {
      spinner.fail(chalk.red(`No backups found for session ${sessionId}`));
      process.exit(1);
    }

    const backupPath = join(backupDir, latestBackup.name);
    const backupDate = new Date(latestBackup.timestamp).toLocaleString();
    
    spinner.succeed(`Found latest backup from ${backupDate}`);

    if (opts.dryRun) {
      console.log(chalk.cyan(`Would restore from: ${backupPath}`));
      console.log(chalk.cyan(`Would restore to: ${file}`));
      return;
    }

    // Confirm restoration
    if (process.stdin.isTTY) {
      const ok = await confirm({ 
        message: chalk.yellow(`Restore session from backup (${backupDate})?`), 
        initialValue: false 
      });
      if (!ok) process.exit(0);
    }

    await fs.copyFile(backupPath, file);
    
    console.log(chalk.bold.green("Restored:"), chalk.white(`${file}`));
    console.log(chalk.dim(`From backup: ${backupPath}`));

  } catch (error) {
    spinner.fail(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}