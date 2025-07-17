#!/usr/bin/env node
import { homedir } from "os";
import { join, basename } from "path";
import fs from "fs-extra";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { confirm } from "@clack/prompts";

// ---------- CLI Definition ----------
const program = new Command()
  .name("claude-prune")
  .description("Prune early messages from a Claude Code session.jsonl file")
  .argument("<sessionId>", "UUID of the session (without .jsonl)")
  .requiredOption("-k, --keep <number>", "number of *message* objects to keep", parseInt)
  .option("--dry-run", "show what would happen but don't write")
  .version("1.0.0")
  .action(main);

// Extract core logic for testing
export function pruneSessionLines(lines: string[], keepN: number): { outLines: string[], kept: number, dropped: number, assistantCount: number } {
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

  // Always include first line
  if (lines.length > 0) {
    outLines.push(lines[0]);
  }

  lines.forEach((ln, idx) => {
    if (idx === 0) return; // Already added above
    
    const isMsg = MSG_TYPES.has((() => { try { return JSON.parse(ln).type; } catch { return ""; } })());
    if (isMsg) {
      if (idx >= cutFrom) { kept++; outLines.push(ln); } else { dropped++; }
    } else {
      outLines.push(ln); // always keep tool lines, etc.
    }
  });

  return { outLines, kept, dropped, assistantCount: assistantIndexes.length };
}

// Only run CLI if not in test environment
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  program.parse();
}

// ---------- Main ----------
async function main(sessionId: string, opts: { keep: number; dryRun?: boolean }) {
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

  const { outLines, kept, dropped, assistantCount } = pruneSessionLines(lines, opts.keep);

  spinner.succeed(`${chalk.green("Scanned")} ${lines.length} lines (${kept} kept, ${dropped} dropped) - ${assistantCount} assistant messages found`);

  if (opts.dryRun) {
    console.log(chalk.cyan("Dry-run only ➜ no files written."));
    return;
  }

  const backup = file.replace('.jsonl', `.bak.${Date.now()}`);
  await fs.copyFile(file, backup);
  await fs.writeFile(file, outLines.join("\n") + "\n");

  console.log(chalk.bold.green("✅ Done:"), chalk.white(`${file}`));
  console.log(chalk.dim(`Backup at ${backup}`));
}