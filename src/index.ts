#!/usr/bin/env node
import { homedir } from "os";
import { join, basename } from "path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm } from "@clack/prompts";
import { execSync } from "child_process";

// ---------- CLI Definition ----------
const program = new Command()
  .name("claude-prune")
  .description("Prune early messages from a Claude Code session.jsonl file")
  .version("1.2.0");

program
  .command("prune")
  .description("Prune early messages from a session, optionally summarizing removed content")
  .argument("<sessionId>", "UUID of the session (without .jsonl)")
  .requiredOption("-k, --keep <number>", "number of *message* objects to keep", parseInt)
  .option("--dry-run", "show what would happen but don't write")
  .option("--summarize-pruned", "summarize the pruned messages and prepend it to the chat")
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
  .option("-k, --keep <number>", "number of *message* objects to keep", parseInt)
  .option("--dry-run", "show what would happen but don't write")
  .option("--summarize-pruned", "summarize the pruned messages and prepend it to the chat")
  .action((sessionId, opts: { keep?: number; dryRun?: boolean; summarizePruned?: boolean }) => {
    if (sessionId && opts.keep) {
      main(sessionId, opts);
    } else {
      program.help();
    }
  });

// Extract core logic for testing
export function pruneSessionLines(lines: string[], keepN: number): { outLines: string[], kept: number, dropped: number, assistantCount: number, droppedMessages: { type: string, content: string }[] } {
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

  const total = msgIndexes.length;
  const keepNSafe = Math.max(0, keepN);
  
  // Find the cutoff point based on last N assistant messages
  let cutFrom = 0;
  if (assistantIndexes.length > keepNSafe) {
    cutFrom = assistantIndexes[assistantIndexes.length - keepNSafe];
  }

  // Pass 2 – build pruned output
  const outLines: string[] = [];
  let kept = 0;
  let dropped = 0;
  const droppedMessages: { type: string, content: string }[] = [];

  // Always include first line
  if (lines.length > 0) {
    outLines.push(lines[0]);
  }

  // HACK: Zero out ONLY the last non-zero cache_read_input_tokens to trick UI percentage
  let lastNonZeroCacheLineIndex = -1;
  let lastNonZeroCacheValue = 0;
  
  // First pass: find the last non-zero cache line
  lines.forEach((ln, i) => {
    try {
      const obj = JSON.parse(ln);
      const usageObj = obj.usage || obj.message?.usage;
      if (usageObj?.cache_read_input_tokens && usageObj.cache_read_input_tokens > 0) {
        lastNonZeroCacheLineIndex = i;
        lastNonZeroCacheValue = usageObj.cache_read_input_tokens;
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
        const { type, message } = parsedObj;
        if (message?.content) {
          droppedMessages.push({ type, content: message.content });
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

// Extract summarization logic for testing
export async function generateSummary(
  droppedMessages: { type: string, content: string }[],
  options: { maxLength?: number } = {}
): Promise<string> {
  const maxLength = options.maxLength || 60000;
  
  let transcriptToSummarize = droppedMessages
    .map(msg => `${msg.type === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
  
  // Guard against shell argument overflow
  if (transcriptToSummarize.length > maxLength) {
    console.log(chalk.yellow(`\nTranscript too long (${transcriptToSummarize.length} chars). Truncating to ${maxLength} chars...`));
    transcriptToSummarize = transcriptToSummarize.substring(0, maxLength) + '\n\n... (transcript truncated due to length)';
  }
  
  // Use single quotes and escape single quotes inside to avoid shell injection
  const prompt = `The following is a transcript of a conversation that is about to be pruned from my session. Please provide a very concise, one-paragraph summary of what was discussed and accomplished. Start the summary with "Previously, we discussed...". The summary will be used as a memory for me. Here is the transcript:\n\n${transcriptToSummarize.replace(/'/g, "'\\''")}`;

  const summaryContent = execSync(`claude -p '${prompt}'`, { 
    encoding: 'utf8',
    timeout: 30000 // 30 second timeout
  });

  return summaryContent.trim();
}

// ---------- Main ----------
async function main(sessionId: string, opts: { keep: number; dryRun?: boolean; summarizePruned?: boolean }) {
  const cwdProject = process.cwd().replace(/\//g, '-');
  const file = join(homedir(), ".claude", "projects", cwdProject, `${sessionId}.jsonl`);

  if (!(await fs.pathExists(file))) {
    console.error(chalk.red(`❌ No transcript at ${file}`));
    process.exit(1);
  }

  // Dry-run confirmation via clack if user forgot --dry-run flag
  if (!opts.dryRun && process.stdin.isTTY) {
    const ok = await confirm({ message: chalk.yellow("Overwrite original file?"), initialValue: true });
    if (!ok) process.exit(0);
  }

  const spinner = ora(`Reading ${file}`).start();
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, opts.keep);

  let summaryAdded = false;
  if (opts.summarizePruned && !opts.dryRun && droppedMessages.length > 0) {
    spinner.start("Summarizing pruned messages with Claude...");
    try {
      const summaryContent = await generateSummary(droppedMessages);

      const summaryLine = JSON.stringify({
        type: "user",
        isCompactSummary: true,
        message: { content: summaryContent }
      });

      // Safely insert after first line if it exists
      if (outLines.length > 0) {
        outLines.splice(1, 0, summaryLine);
      } else {
        outLines.push(summaryLine);
      }
      summaryAdded = true;
      spinner.succeed("Summarization complete.");
    } catch (error) {
      spinner.fail("Failed to summarize messages. Make sure Claude CLI is installed and available.");
      console.error(chalk.red(error));
      process.exit(1);
    }
  }

  const summaryMessage = summaryAdded ? chalk.blue(" (+1 summary)") : "";
  spinner.succeed(`${chalk.green("Scanned")} ${lines.length} lines (${kept} kept, ${dropped} dropped) - ${assistantCount} assistant messages found${summaryMessage}`);

  if (opts.dryRun) {
    console.log(chalk.cyan("Dry-run only ➜ no files written."));
    return;
  }

  const backupDir = join(homedir(), ".claude", "projects", cwdProject, "prune-backup");
  await fs.ensureDir(backupDir);
  const backup = join(backupDir, `${sessionId}.jsonl.${Date.now()}`);
  await fs.copyFile(file, backup);
  await fs.writeFile(file, outLines.join("\n") + "\n");

  console.log(chalk.bold.green("✅ Done:"), chalk.white(`${file}`));
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
  const file = join(homedir(), ".claude", "projects", cwdProject, `${sessionId}.jsonl`);
  const backupDir = join(homedir(), ".claude", "projects", cwdProject, "prune-backup");

  if (!(await fs.pathExists(backupDir))) {
    console.error(chalk.red(`❌ No backup directory found at ${backupDir}`));
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
    
    console.log(chalk.bold.green("✅ Restored:"), chalk.white(`${file}`));
    console.log(chalk.dim(`From backup: ${backupPath}`));

  } catch (error) {
    spinner.fail(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}