#!/usr/bin/env node
import { homedir } from "os";
import { join } from "path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm } from "@clack/prompts";
import { execSync } from "child_process";

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

// ---------- CLI Definition ----------
const program = new Command()
  .name("ccprune")
  .description("Prune early messages from a Claude Code session.jsonl file")
  .version("2.2.0");

program
  .command("prune")
  .description("Prune early messages from a session (summarizes by default)")
  .argument("<sessionId>", "UUID of the session (without .jsonl)")
  .option("-k, --keep <number>", "number of assistant messages to keep", parseInt)
  .option("-p, --keep-percent <number>", "percentage of assistant messages to keep (1-100)", parseInt)
  .option("--dry-run", "preview changes without writing (still generates summary preview)")
  .option("--no-summary", "skip AI summarization of pruned messages")
  .option("--summary-model <model>", "model for summarization (haiku, sonnet, or full name)")
  .action(main);

program
  .command("restore")
  .description("Restore a session from the latest backup")
  .argument("<sessionId>", "UUID of the session to restore (without .jsonl)")
  .option("--dry-run", "show what would be restored but don't write")
  .action(restore);

// For backward compatibility, make prune the default command
program
  .argument("[sessionId]", "UUID of the session (without .jsonl)")
  .option("-k, --keep <number>", "number of assistant messages to keep", parseInt)
  .option("-p, --keep-percent <number>", "percentage of assistant messages to keep (1-100)", parseInt)
  .option("--dry-run", "preview changes without writing (still generates summary preview)")
  .option("--no-summary", "skip AI summarization of pruned messages")
  .option("--summary-model <model>", "model for summarization (haiku, sonnet, or full name)")
  .action((sessionId, opts: { keep?: number; keepPercent?: number; dryRun?: boolean; summary?: boolean; summaryModel?: string }) => {
    if (sessionId) {
      main(sessionId, opts);
    } else {
      program.help();
    }
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

// Extract summarization logic for testing
export async function generateSummary(
  droppedMessages: { type: string, content: string, isSummary?: boolean }[],
  options: { maxLength?: number; model?: string } = {}
): Promise<string> {
  const maxLength = options.maxLength || 60000;

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

  if (transcriptToSummarize.length > maxLength) {
    console.log(chalk.yellow(`\nTranscript too long (${transcriptToSummarize.length} chars). Truncating to ${maxLength} chars...`));
    const truncated = transcriptToSummarize.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastSpace, lastNewline);
    transcriptToSummarize = truncated.substring(0, cutPoint > 0 ? cutPoint : maxLength) + '\n\n... (transcript truncated due to length)';
  }

  let prompt: string;
  if (existingSummary) {
    // Synthesis mode: combine old summary + new messages
    prompt = `I have an existing summary of earlier work, followed by a more recent conversation that is being pruned. Please synthesize these into a single coherent summary paragraph. Start with "Previously, we discussed...".

EXISTING SUMMARY:
${existingSummary.content}

MORE RECENT CONVERSATION TO INCORPORATE:
${transcriptToSummarize}`;
  } else {
    // Fresh summary (no existing summary)
    prompt = `The following is a transcript of a conversation that is about to be pruned from my session. Please provide a very concise, one-paragraph summary of what was discussed and accomplished. Start the summary with "Previously, we discussed...". The summary will be used as a memory for me. Here is the transcript:\n\n${transcriptToSummarize}`;
  }

  const args = ['-p'];
  if (options.model) {
    args.push('--model', options.model);
  }

  try {
    const summaryContent = execSync(`claude ${args.join(' ')}`, {
      input: prompt,
      encoding: 'utf8',
      timeout: 60000
    });
    return summaryContent.trim();
  } catch (error: any) {
    if (error.killed || error.signal === 'SIGTERM') {
      throw new Error('Summary generation timed out. Try with --summary-model haiku for faster results.');
    }
    if (error.code === 'ENOENT' || error.message?.includes('not found')) {
      throw new Error('Claude CLI not found. Make sure Claude Code is installed and the "claude" command is available.');
    }
    throw error;
  }
}

// ---------- Main ----------
async function main(sessionId: string, opts: { keep?: number; keepPercent?: number; dryRun?: boolean; summary?: boolean; summaryModel?: string }) {
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

  // Confirmation via clack if not dry-run
  if (!opts.dryRun && process.stdin.isTTY) {
    const ok = await confirm({ message: chalk.yellow("Overwrite original file?"), initialValue: true });
    if (!ok) process.exit(0);
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

  const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, keepN);
  spinner.succeed(`${chalk.green("Scanned")} ${lines.length} lines (${kept} kept, ${dropped} dropped) - keeping ${keepN} assistant messages${percentInfo}`);

  // Summarization is ON by default (opts.summary is undefined or true)
  // OFF only when explicitly set to false via --no-summary
  const shouldSummarize = opts.summary !== false && droppedMessages.length > 0;

  let summaryContent: string | null = null;
  if (shouldSummarize) {
    const modelInfo = opts.summaryModel ? ` using ${opts.summaryModel}` : '';
    spinner.start(`Generating summary with Claude${modelInfo}...`);
    try {
      summaryContent = await generateSummary(droppedMessages, { model: opts.summaryModel });
      spinner.succeed("Summary generated.");
    } catch (error: any) {
      spinner.fail(`Failed to generate summary: ${error.message}`);
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  }

  // When --no-summary but existing summary was dropped, preserve it
  const existingSummaryInDropped = droppedMessages.find(m => m.isSummary);
  if (!shouldSummarize && existingSummaryInDropped) {
    summaryContent = existingSummaryInDropped.content;
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
      console.log(chalk.dim("(Would be inserted after first line)"));
    }
    console.log(chalk.cyan("\nNo files written."));
    return;
  }

  // Insert summary if generated
  if (summaryContent) {
    // Extract context from first real message (skip file-history-snapshot if present)
    let sessionContext = { sessionId: '', cwd: '', slug: '', gitBranch: '', version: '2.0.53' };

    for (let i = 1; i < outLines.length && i < 10; i++) {
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
          break;
        }
      } catch { /* not JSON */ }
    }

    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: summaryContent },
      uuid: generateUUID(),
      timestamp: new Date().toISOString(),
      parentUuid: null,
      sessionId: sessionContext.sessionId,
      cwd: sessionContext.cwd,
      slug: sessionContext.slug,
      gitBranch: sessionContext.gitBranch,
      version: sessionContext.version,
      isSidechain: false,
      userType: "external"
    });

    if (outLines.length > 0) {
      outLines.splice(1, 0, summaryLine);
    } else {
      outLines.push(summaryLine);
    }
  }

  const backupDir = join(getClaudeConfigDir(), "projects", cwdProject, "prune-backup");
  await fs.ensureDir(backupDir);
  const backup = join(backupDir, `${sessionId}.jsonl.${Date.now()}`);
  await fs.copyFile(file, backup);
  await fs.writeFile(file, outLines.join("\n") + "\n");

  const summaryMsg = summaryContent ? chalk.blue(" (+1 summary)") : "";
  console.log(chalk.bold.green("Done:"), chalk.white(`${file}${summaryMsg}`));
  console.log(chalk.dim(`Backup at ${backup}`));
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