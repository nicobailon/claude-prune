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
  const cwdProject = process.cwd().replace(/[\/\.]/g, '-');
  return join(getClaudeConfigDir(), "projects", cwdProject);
}

// ---------- CLI Definition ----------
const program = new Command()
  .name("ccprune")
  .description("Prune early messages from a Claude Code session.jsonl file")
  .version("4.2.0")
  .enablePositionalOptions();

program
  .command("restore")
  .description("Restore a session from the latest backup")
  .argument("<sessionId>", "UUID of the session to restore (without .jsonl)")
  .option("--dry-run", "show what would be restored but don't write")
  .action(function(sessionId) {
    return restore(sessionId, this.opts());
  });

program
  .command("undo")
  .description("Undo the last prune by restoring the most recent session from backup")
  .option("--dry-run", "show what would be restored but don't write")
  .action(function() {
    return undo(this.opts());
  });

// Default command - prune session
const DEFAULT_KEEP_TOKENS = 55000;
const DEFAULT_PROTECTED_TOOLS = new Set([
  'Edit', 'Write', 'TodoWrite', 'TodoRead', 'AskUserQuestion'
]);

program
  .argument("[sessionId]", "UUID of the session (auto-detects latest if omitted)")
  .option("-k, --keep <number>", "tokens to retain (default: 55000)", parseInt)
  .option("--keep-tokens <number>", "tokens to retain (alias for -k)", parseInt)
  .option("--pick", "interactively select from available sessions")
  .option("-n, --no-resume", "skip automatic session resume")
  .option("--yolo", "resume with --dangerously-skip-permissions")
  .option("--resume-model <model>", "model for resumed session (opus, sonnet, haiku, opusplan)")
  .option("--dry-run", "preview changes without writing (still generates summary preview)")
  .option("--no-summary", "skip AI summarization of pruned messages")
  .option("--summary-model <model>", "model for summarization (haiku, sonnet, or full name)")
  .option("--summary-timeout <ms>", "max total time for summarization in ms (default: 360000)", parseInt)
  .option("--gemini", "use Gemini 3 Pro for summarization (requires GEMINI_API_KEY)")
  .option("--gemini-flash", "use Gemini 2.5 Flash for summarization (requires GEMINI_API_KEY)")
  .option("--claude-code", "use Claude Code CLI for summarization (chunks large transcripts)")
  .option("--prune-tools", "replace tool outputs with placeholders to reduce tokens")
  .option("--prune-tools-ai", "use AI to determine which tool outputs to prune")
  .option("--prune-tools-dedup", "deduplicate identical tool calls, keep only most recent")
  .option("--prune-tools-max", "maximum savings: dedup + AI analysis combined")
  .option("--prune-tools-keep <tools>", "comma-separated tools to never prune (default: Edit,Write,TodoWrite,TodoRead,AskUserQuestion)")
  .option("--skip-tool-pruning", "disable automatic tool output pruning")
  .action(function(sessionId) {
    return pruneCommand(sessionId, this.opts());
  });

// Count tokens in session (for token-based pruning)
const MSG_TYPES = new Set(["user", "assistant", "system"]);

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') {
    return Math.ceil(content.length / 4);
  }
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'image') {
        tokens += 4000;
      } else if (b.type === 'text' && typeof b.text === 'string') {
        tokens += Math.ceil((b.text as string).length / 4);
      } else if (b.type === 'tool_result') {
        if (typeof b.content === 'string') {
          tokens += Math.ceil((b.content as string).length / 4);
        } else if (Array.isArray(b.content)) {
          tokens += estimateContentTokens(b.content);
        }
      } else if (b.type === 'tool_use') {
        tokens += 50;
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        tokens += Math.ceil((b.thinking as string).length / 4);
      } else {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }
    return tokens;
  }
  return 0;
}

export interface TokenBreakdown {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  estimated: number;
}

export function countSessionTokens(lines: string[]): {
  total: number;
  perLine: Map<number, number>;
  breakdown: TokenBreakdown;
} {
  const perLine = new Map<number, number>();
  const breakdown: TokenBreakdown = { input: 0, cacheRead: 0, cacheCreation: 0, estimated: 0 };

  let rawSum = 0;
  const rawTokens = new Map<number, number>();

  lines.forEach((line, i) => {
    if (i === 0) return;
    try {
      const obj = JSON.parse(line);
      if (MSG_TYPES.has(obj.type)) {
        const usage = obj.message?.usage;
        const content = obj.message?.content;

        if (usage?.cache_read_input_tokens || usage?.cache_creation_input_tokens) {
          breakdown.cacheRead = usage.cache_read_input_tokens ?? 0;
          breakdown.cacheCreation = usage.cache_creation_input_tokens ?? 0;
          breakdown.input = usage.input_tokens ?? 0;
        }

        const raw = usage?.output_tokens ?? estimateContentTokens(content);
        if (!usage?.output_tokens) {
          breakdown.estimated += raw;
        }

        rawTokens.set(i, raw);
        rawSum += raw;
      }
    } catch {}
  });

  const cacheTotal = breakdown.cacheRead + breakdown.cacheCreation + breakdown.input;
  const total = cacheTotal > 0 ? cacheTotal : rawSum;

  const scaleFactor = rawSum > 0 ? total / rawSum : 1;

  for (const [i, raw] of rawTokens) {
    perLine.set(i, Math.ceil(raw * scaleFactor));
  }

  return { total, perLine, breakdown };
}

// Count assistant messages (for stats display)
export function countAssistantMessages(lines: string[]): number {
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    try {
      const { type } = JSON.parse(lines[i]);
      if (type === 'assistant') count++;
    } catch {}
  }
  return count;
}

// Clean orphaned tool_results from ALL user messages
// These reference tool_use blocks in dropped assistant messages
export function cleanOrphanedToolResults(lines: string[]): string[] {
  const result = [...lines];

  // First pass: collect all tool_use IDs from assistant messages
  const validToolUseIds = new Set<string>();
  for (let i = 1; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use' && block.id) {
            validToolUseIds.add(block.id);
          }
        }
      }
    } catch {}
  }

  // Second pass: remove tool_results that reference non-existent tool_use IDs
  const toRemove: number[] = [];
  for (let i = 1; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.isCompactSummary) continue;
      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        const filtered = obj.message.content.filter((block: any) => {
          if (block.type !== 'tool_result') return true;
          return validToolUseIds.has(block.tool_use_id);
        });
        if (filtered.length === 0) {
          toRemove.push(i);
        } else if (filtered.length !== obj.message.content.length) {
          obj.message.content = filtered;
          result[i] = JSON.stringify(obj);
        }
      }
    } catch {}
  }

  // Remove empty messages in reverse order to preserve indices
  for (let i = toRemove.length - 1; i >= 0; i--) {
    result.splice(toRemove[i], 1);
  }

  return result;
}

// Prune tool outputs by replacing content with placeholders
export function pruneToolOutputs(
  lines: string[],
  protectedTools: Set<string> = DEFAULT_PROTECTED_TOOLS,
  targetIds?: Set<string>
): { lines: string[], prunedCount: number, savedBytes: number } {
  const result = [...lines];
  let prunedCount = 0;
  let savedBytes = 0;

  // Build map of tool_use_id -> tool name
  const toolUseMap = new Map<string, string>();
  for (const line of result) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolUseMap.set(block.id, block.name);
          }
        }
      }
    } catch {}
  }

  // Replace tool_result content with placeholders
  for (let i = 0; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        let modified = false;
        for (const block of obj.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolName = toolUseMap.get(block.tool_use_id) || 'Unknown';
            if (protectedTools.has(toolName)) continue;
            if (targetIds && !targetIds.has(block.tool_use_id)) continue;

            const originalSize = JSON.stringify(block.content).length;
            if (originalSize > 100) {
              block.content = `[Pruned: ${toolName} output - ${originalSize} bytes]`;
              savedBytes += originalSize - block.content.length;
              prunedCount++;
              modified = true;
            }
          }
        }
        if (modified) {
          result[i] = JSON.stringify(obj);
        }
      }
    } catch {}
  }

  return { lines: result, prunedCount, savedBytes };
}

// Deduplicate tool calls - keep only most recent for identical inputs
export function deduplicateToolCalls(
  lines: string[],
  protectedTools: Set<string> = DEFAULT_PROTECTED_TOOLS
): { lines: string[], dedupCount: number, savedBytes: number } {
  const result = [...lines];
  let dedupCount = 0;
  let savedBytes = 0;

  // Build map: tool_use_id -> { name, inputHash, lineIndex }
  const toolUseMap = new Map<string, { name: string; inputHash: string; lineIndex: number }>();

  for (let i = 0; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            const inputHash = JSON.stringify(block.input || {});
            toolUseMap.set(block.id, { name: block.name, inputHash, lineIndex: i });
          }
        }
      }
    } catch {}
  }

  // Group by (toolName + inputHash) to find duplicates
  const callGroups = new Map<string, string[]>();
  for (const [id, info] of toolUseMap) {
    if (protectedTools.has(info.name)) continue;
    const key = `${info.name}:${info.inputHash}`;
    if (!callGroups.has(key)) callGroups.set(key, []);
    callGroups.get(key)!.push(id);
  }

  // Build map of tool_use_id -> tool_result line index
  const toolResultMap = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultMap.set(block.tool_use_id, i);
          }
        }
      }
    } catch {}
  }

  // For each group with duplicates, prune all but the last
  for (const [, ids] of callGroups) {
    if (ids.length <= 1) continue;

    const totalCalls = ids.length;
    ids.sort((a, b) => toolUseMap.get(a)!.lineIndex - toolUseMap.get(b)!.lineIndex);

    // Prune all but the last
    for (let callNum = 0; callNum < ids.length - 1; callNum++) {
      const id = ids[callNum];
      const toolName = toolUseMap.get(id)!.name;
      const resultLineIdx = toolResultMap.get(id);
      if (resultLineIdx === undefined) continue;

      try {
        const obj = JSON.parse(result[resultLineIdx]);
        if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id === id) {
              const originalSize = JSON.stringify(block.content).length;
              block.content = `[Pruned: duplicate ${toolName} call ${callNum + 1}/${totalCalls}]`;
              savedBytes += originalSize - block.content.length;
              dedupCount++;
            }
          }
          result[resultLineIdx] = JSON.stringify(obj);
        }
      } catch {}
    }

    // Annotate the last (kept) with total count
    const lastId = ids[ids.length - 1];
    const lastResultLineIdx = toolResultMap.get(lastId);
    if (lastResultLineIdx !== undefined) {
      try {
        const obj = JSON.parse(result[lastResultLineIdx]);
        if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id === lastId) {
              if (typeof block.content === 'string') {
                block.content = `${block.content}\n\n[${totalCalls} total calls]`;
              }
            }
          }
          result[lastResultLineIdx] = JSON.stringify(obj);
        }
      } catch {}
    }
  }

  return { lines: result, dedupCount, savedBytes };
}

// AI-based pruning: use LLM to identify irrelevant tool outputs
export async function getAIPruneTargets(
  lines: string[],
  protectedTools: Set<string>,
  opts: { gemini?: boolean; geminiFlash?: boolean; summaryModel?: string; summaryTimeout?: number }
): Promise<Set<string>> {
  // Build list of tool calls with their outputs (truncated for prompt)
  const toolCalls: { id: string; name: string; inputPreview: string; outputPreview: string }[] = [];

  // Build map of tool_use_id -> { name, input }
  const toolUseMap = new Map<string, { name: string; input: string }>();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            if (protectedTools.has(block.name)) continue;
            toolUseMap.set(block.id, {
              name: block.name,
              input: JSON.stringify(block.input || {}).slice(0, 100)
            });
          }
        }
      }
    } catch {}
  }

  // Match tool_results
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolInfo = toolUseMap.get(block.tool_use_id);
            if (toolInfo) {
              const outputStr = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              toolCalls.push({
                id: block.tool_use_id,
                name: toolInfo.name,
                inputPreview: toolInfo.input,
                outputPreview: outputStr.slice(0, 200)
              });
            }
          }
        }
      }
    } catch {}
  }

  if (toolCalls.length === 0) {
    return new Set();
  }

  const prompt = `Analyze this Claude Code session's tool calls and identify which outputs are NO LONGER RELEVANT to the current task.

Tool calls in this session:
${toolCalls.map((t, i) => `${i + 1}. [${t.id}] ${t.name}: ${t.inputPreview} → ${t.outputPreview}...`).join('\n')}

Return ONLY a JSON array of tool_use_ids that should be pruned (outputs no longer needed).
Example: ["toolu_01abc", "toolu_02def"]

Consider keeping:
- Recent file reads (may be referenced)
- Error outputs (context for debugging)
- Configuration/setup results

Prune:
- Outdated file reads (file was read again later)
- Exploratory searches not related to current work
- Large outputs that were just glanced at

Return ONLY the JSON array, nothing else:`;

  try {
    let response: string;

    if (opts.gemini) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.log(chalk.yellow('No GEMINI_API_KEY, skipping AI pruning'));
        return new Set();
      }

      const model = opts.geminiFlash ? 'gemini-2.5-flash' : 'gemini-3-pro-preview';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
        })
      });

      if (!res.ok) {
        console.log(chalk.yellow(`Gemini API error: ${res.status}`));
        return new Set();
      }

      const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      response = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const args = ['-p'];
      if (opts.summaryModel) args.push('--model', opts.summaryModel);
      response = await spawnClaudeAsync(args, prompt, opts.summaryTimeout || 60000);
    }

    // Parse JSON array from response
    const match = response.match(/\[[\s\S]*?\]/);
    if (match) {
      const ids = JSON.parse(match[0]);
      return new Set(ids.filter((id: unknown) => typeof id === 'string'));
    }
  } catch (err) {
    console.log(chalk.yellow(`AI pruning analysis failed: ${err}`));
  }

  return new Set();
}

// Extract core logic for testing
export function pruneSessionLines(lines: string[], keepTokens: number): { outLines: string[], kept: number, dropped: number, assistantCount: number, keptTokens: number, droppedTokens: number, droppedMessages: { type: string, content: string, isSummary?: boolean }[] } {
  const { total: totalTokens, perLine } = countSessionTokens(lines);
  const msgIndexes: number[] = [];
  const assistantIndexes: number[] = [];

  lines.forEach((ln, i) => {
    if (i === 0) return;
    try {
      const { type } = JSON.parse(ln);
      if (MSG_TYPES.has(type)) {
        msgIndexes.push(i);
        if (type === "assistant") {
          assistantIndexes.push(i);
        }
      }
    } catch {}
  });

  // Find cutoff by scanning right-to-left until we accumulate keepTokens
  let accumulated = 0;
  let cutFrom = 0;

  for (let i = lines.length - 1; i >= 1; i--) {
    const tokens = perLine.get(i) ?? 0;
    if (tokens > 0) {
      if (accumulated + tokens > keepTokens && (accumulated > 0 || keepTokens <= 0)) {
        cutFrom = i + 1;
        break;
      }
      accumulated += tokens;
    }
  }

  // Pass 2 – build pruned output
  const outLines: string[] = [];
  let kept = 0;
  let dropped = 0;
  let keptTokens = 0;
  let droppedTokens = 0;
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
      const msgTokens = perLine.get(idx) ?? 0;
      if (idx >= cutFrom) {
        kept++;
        keptTokens += msgTokens;
        outLines.push(ln);
      } else {
        dropped++;
        droppedTokens += msgTokens;
        const { type, message, isCompactSummary } = parsedObj;
        if (message?.content !== undefined) {
          const contentStr = extractMessageContent(message.content);
          droppedMessages.push({ type, content: contentStr, isSummary: isCompactSummary === true });
        }
      }
    } else {
      outLines.push(ln);
    }
  });

  // Clean up orphaned tool_results using shared function
  const cleanedOutLines = cleanOrphanedToolResults(outLines);
  outLines.length = 0;
  outLines.push(...cleanedOutLines);

  // Update leafUuid in first line to point to last message
  if (outLines.length > 1) {
    let lastMsgUuid: string | null = null;
    for (let i = outLines.length - 1; i >= 1; i--) {
      try {
        const obj = JSON.parse(outLines[i]);
        if (MSG_TYPES.has(obj.type) && obj.uuid) {
          lastMsgUuid = obj.uuid;
          break;
        }
      } catch {}
    }

    if (lastMsgUuid) {
      try {
        const firstLine = JSON.parse(outLines[0]);
        if (firstLine.type === 'summary' && firstLine.leafUuid) {
          firstLine.leafUuid = lastMsgUuid;
          outLines[0] = JSON.stringify(firstLine);
        }
      } catch {}
    }
  }

  return { outLines, kept, dropped, assistantCount: assistantIndexes.length, keptTokens, droppedTokens, droppedMessages };
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
  opts: { keep?: number; keepTokens?: number; pick?: boolean; resume?: boolean; dryRun?: boolean; summary?: boolean; summaryModel?: string; summaryTimeout?: number; gemini?: boolean; geminiFlash?: boolean; claudeCode?: boolean; yolo?: boolean; pruneTools?: boolean; pruneToolsAi?: boolean; pruneToolsDedup?: boolean; pruneToolsMax?: boolean; pruneToolsKeep?: string; skipToolPruning?: boolean; resumeModel?: string }
) {
  // Merge --keep-tokens into --keep (alias)
  if (opts.keepTokens !== undefined) {
    opts.keep = opts.keepTokens;
  }
  // Auto-detect GEMINI_API_KEY and default to Gemini Flash
  // Priority: --claude-code > --gemini > --gemini-flash > auto-detect > fallback to Claude Code
  if (!opts.claudeCode && !opts.gemini && !opts.geminiFlash) {
    if (process.env.GEMINI_API_KEY) {
      opts.gemini = true;
      opts.geminiFlash = true;
    }
  }

  // --gemini-flash implies --gemini
  if (opts.geminiFlash) {
    opts.gemini = true;
  }

  // Validate Gemini (only error if explicitly requested without key)
  if (opts.gemini && !opts.claudeCode && !process.env.GEMINI_API_KEY) {
    console.error(chalk.red('Error: GEMINI_API_KEY environment variable is required for --gemini/--gemini-flash'));
    console.error(chalk.dim('Set it: export GEMINI_API_KEY=your_key'));
    console.error(chalk.dim('Or use --claude-code for Claude Code CLI'));
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

    const sessionContent = await fs.readFile(latest.path, 'utf-8');
    const sessionLines = sessionContent.split('\n').filter(l => l.trim());
    const assistantCount = countAssistantMessages(sessionLines);
    const { total: totalTokens, breakdown } = countSessionTokens(sessionLines);

    console.log();
    console.log(chalk.bold.cyan('SESSION'));
    console.log(chalk.white('  ID: ') + chalk.bold.yellow(latest.id));
    console.log(chalk.white('  Modified: ') + chalk.dim(latest.modifiedAt.toLocaleString()));
    console.log(chalk.white('  Size: ') + chalk.dim(`${latest.sizeKB}KB`));
    console.log(chalk.white('  Tokens: ') + chalk.bold(`${totalTokens.toLocaleString()}`));
    console.log(chalk.dim(`    input: ${breakdown.input.toLocaleString()} | cache_read: ${breakdown.cacheRead.toLocaleString()} | cache_create: ${breakdown.cacheCreation.toLocaleString()}${breakdown.estimated > 0 ? ` | estimated: ${breakdown.estimated.toLocaleString()}` : ''}`));
    console.log(chalk.white('  Messages: ') + chalk.dim(`${assistantCount} assistant`));
    console.log();

    if (assistantCount < 5) {
      console.log(chalk.yellow('Warning: This session has very few messages.'));
      console.log(chalk.dim('This may not be the session you intended to prune.'));
      console.log();

      const shouldContinue = await confirm({
        message: 'Continue with this session?',
        initialValue: false
      });

      if (shouldContinue !== true) {
        console.log(chalk.dim('Use --pick to select a different session'));
        process.exit(0);
      }
    }

    sessionId = latest.id;
  }

  return main(sessionId, opts);
}

// ---------- Main ----------
async function main(sessionId: string, opts: { keep?: number; resume?: boolean; dryRun?: boolean; summary?: boolean; summaryModel?: string; summaryTimeout?: number; gemini?: boolean; geminiFlash?: boolean; yolo?: boolean; pruneTools?: boolean; pruneToolsAi?: boolean; pruneToolsDedup?: boolean; pruneToolsMax?: boolean; pruneToolsKeep?: string; skipToolPruning?: boolean; resumeModel?: string }) {
  const cwdProject = process.cwd().replace(/[\/\.]/g, '-');
  const file = join(getClaudeConfigDir(), "projects", cwdProject, `${sessionId}.jsonl`);

  if (!(await fs.pathExists(file))) {
    console.error(chalk.red(`No transcript at ${file}`));
    process.exit(1);
  }

  if (opts.keep !== undefined && isNaN(opts.keep)) {
    console.error(chalk.red('--keep must be a valid number'));
    process.exit(1);
  }

  const spinner = ora(`Reading ${file}`).start();
  const raw = await fs.readFile(file, "utf8");
  let lines = raw.split(/\r?\n/).filter(Boolean);

  // Apply tool pruning (runs by default, before token counting)
  const protectedTools = opts.pruneToolsKeep
    ? new Set(opts.pruneToolsKeep.split(',').map(s => s.trim()))
    : DEFAULT_PROTECTED_TOOLS;

  let toolPruningMadeChanges = false;
  const noExplicitToolFlag = !opts.pruneTools && !opts.pruneToolsAi &&
                             !opts.pruneToolsDedup && !opts.pruneToolsMax;
  const skipToolPruning = opts.skipToolPruning === true;

  if (skipToolPruning) {
    // --skip-tool-pruning: do nothing
  } else if (noExplicitToolFlag || opts.pruneToolsMax) {
    // DEFAULT (no flags) or --prune-tools-max: run dedup + AI
    spinner.text = 'Deduplicating tool calls...';
    const { lines: dedupedLines, dedupCount, savedBytes: dedupSaved } = deduplicateToolCalls(lines, protectedTools);
    lines = dedupedLines;

    spinner.text = 'Analyzing tool outputs with AI...';
    const aiPruneTargets = await getAIPruneTargets(lines, protectedTools, opts);
    const { lines: aiPrunedLines, prunedCount, savedBytes: aiSaved } = pruneToolOutputs(lines, protectedTools, aiPruneTargets);
    lines = aiPrunedLines;

    if (dedupCount > 0 || prunedCount > 0) {
      toolPruningMadeChanges = true;
      console.log(chalk.dim(`\nTool pruning: ${dedupCount} deduped + ${prunedCount} AI-pruned (saved ~${Math.round((dedupSaved + aiSaved) / 1024)}KB)`));
    }
  } else if (opts.pruneToolsDedup) {
    spinner.text = 'Deduplicating tool calls...';
    const { lines: dedupedLines, dedupCount, savedBytes } = deduplicateToolCalls(lines, protectedTools);
    lines = dedupedLines;
    if (dedupCount > 0) {
      toolPruningMadeChanges = true;
      console.log(chalk.dim(`\nDeduplicated ${dedupCount} duplicate tool calls (saved ~${Math.round(savedBytes / 1024)}KB)`));
    }
  } else if (opts.pruneToolsAi) {
    spinner.text = 'Analyzing tool outputs with AI...';
    const aiPruneTargets = await getAIPruneTargets(lines, protectedTools, opts);
    const { lines: prunedLines, prunedCount, savedBytes } = pruneToolOutputs(lines, protectedTools, aiPruneTargets);
    lines = prunedLines;
    if (prunedCount > 0) {
      toolPruningMadeChanges = true;
      console.log(chalk.dim(`\nAI identified ${aiPruneTargets.size} outputs to prune (saved ~${Math.round(savedBytes / 1024)}KB)`));
    }
  } else if (opts.pruneTools) {
    spinner.text = 'Pruning tool outputs...';
    const { lines: prunedLines, prunedCount, savedBytes } = pruneToolOutputs(lines, protectedTools);
    lines = prunedLines;
    if (prunedCount > 0) {
      toolPruningMadeChanges = true;
      console.log(chalk.dim(`\nPruned ${prunedCount} tool outputs (saved ~${Math.round(savedBytes / 1024)}KB)`));
    }
  }

  const keepTokens = opts.keep ?? DEFAULT_KEEP_TOKENS;
  const { total: totalTokens, breakdown } = countSessionTokens(lines);

  const originalSizeKB = Math.round(raw.length / 1024);
  const msgCounts = countMessageTypes(lines);

  spinner.succeed(`${chalk.green("Scanned")} ${file}`);

  console.log();
  console.log(chalk.bold('Token Breakdown:'));
  console.log(chalk.dim(`  input: ${breakdown.input.toLocaleString()} | cache_read: ${breakdown.cacheRead.toLocaleString()} | cache_create: ${breakdown.cacheCreation.toLocaleString()}${breakdown.estimated > 0 ? ` | estimated: ${breakdown.estimated.toLocaleString()}` : ''}`));
  console.log(chalk.bold(`  Total: ${totalTokens.toLocaleString()}`));

  // Early exit if under threshold
  if (totalTokens <= keepTokens) {
    console.log();
    console.log(chalk.green(`Session has ${totalTokens.toLocaleString()} tokens (under ${keepTokens.toLocaleString()} threshold) - no compaction needed`));

    // Still clean orphaned tool_results even without compaction
    const cleanedLines = cleanOrphanedToolResults(lines);
    const orphanCleanupMadeChanges = cleanedLines.length !== lines.length ||
      cleanedLines.some((l, i) => l !== lines[i]);

    // Write file if tool pruning OR orphan cleanup made changes
    if (toolPruningMadeChanges || orphanCleanupMadeChanges) {
      fs.writeFileSync(file, cleanedLines.join('\n') + '\n');
      if (toolPruningMadeChanges) {
        console.log(chalk.yellow('Saved tool pruning changes'));
      }
      if (orphanCleanupMadeChanges) {
        console.log(chalk.yellow('Cleaned orphaned tool_results'));
      }
    }

    console.log();

    // Skip to auto-resume
    if (process.stdin.isTTY && opts.resume !== false) {
      const barWidth = 50;
      const spinnerChars = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
      let spinnerIndex = 0;

      for (let i = 5; i > 0; i--) {
        const spinChar = spinnerChars[spinnerIndex % spinnerChars.length];
        const progress = (5 - i) / 5;
        const filled = Math.floor(progress * barWidth);
        const progressBar = chalk.green('\u2588'.repeat(filled)) + chalk.gray('\u2591'.repeat(barWidth - filled));

        const percentage = Math.floor(progress * 100);
        const timeDisplay = i === 1 ? '1 second ' : `${i} seconds`;

        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        process.stdout.write(
          `  ${chalk.cyan(spinChar)} ` +
          chalk.yellow('RESUMING IN... ') +
          `[${progressBar}] ` +
          chalk.bold.white(`${percentage}% `) +
          chalk.yellow(`(${timeDisplay} remaining) `) +
          chalk.dim('Press Ctrl+C to cancel')
        );

        spinnerIndex++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      console.log(chalk.bold.green('  RESUMING SESSION NOW!\n'));

      const args = [
        ...(opts.yolo ? ['--dangerously-skip-permissions'] : []),
        '--resume', sessionId,
        ...(opts.resumeModel ? ['--model', opts.resumeModel] : [])
      ];

      console.log(chalk.dim(`Resuming: claude ${args.join(' ')}\n`));

      const child = spawn('claude', args, { stdio: 'inherit' });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.error(chalk.red(`\n'claude' not found. Run manually:`));
          console.error(chalk.white(`  claude ${args.join(' ')}`));
        } else {
          console.error(chalk.red(`\nFailed to start claude: ${err.message}`));
        }
        process.exit(1);
      });

      child.on('close', (code) => process.exit(code ?? 0));
    }
    return;
  }

  console.log();
  console.log(formatOriginalStats({
    lines: lines.length,
    userMsgs: msgCounts.user,
    assistantMsgs: msgCounts.assistant,
    systemMsgs: msgCounts.system,
    sizeKB: originalSizeKB
  }));
  console.log();

  const { outLines, kept, dropped, keptTokens, droppedTokens, droppedMessages } = pruneSessionLines(lines, keepTokens);
  console.log(chalk.dim(`Keeping ${keptTokens.toLocaleString()} tokens (target: ${keepTokens.toLocaleString()}) - ${kept} messages kept, ${dropped} dropped`));

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

    // Extract context, timestamp, parentUuid and index from first real message
    let sessionContext = { sessionId: '', cwd: '', slug: '', gitBranch: '', version: '2.0.53' };
    let firstMessageTimestamp: string | null = null;
    let firstKeptMsgIndex = -1;
    let firstKeptMsgParentUuid: string | null = null;

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
          firstKeptMsgIndex = i;
          firstKeptMsgParentUuid = parsed.parentUuid || null;
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

    const summaryUuid = generateUUID();
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: summaryContent },
      uuid: summaryUuid,
      timestamp: summaryTimestamp,
      parentUuid: firstKeptMsgParentUuid,
      sessionId: sessionContext.sessionId,
      cwd: sessionContext.cwd,
      slug: sessionContext.slug,
      gitBranch: sessionContext.gitBranch,
      version: sessionContext.version,
      isSidechain: false,
      userType: "external"
    });

    // Insert summary right before first kept message and link the chain
    if (firstKeptMsgIndex !== -1) {
      outLines.splice(firstKeptMsgIndex, 0, summaryLine);
      // Update first kept message (now at firstKeptMsgIndex + 1) to point to summary
      const adjustedIndex = firstKeptMsgIndex + 1;
      try {
        const parsed = JSON.parse(outLines[adjustedIndex]);
        parsed.parentUuid = summaryUuid;
        outLines[adjustedIndex] = JSON.stringify(parsed);
      } catch { /* shouldn't happen */ }
    } else {
      // No kept messages - just append summary
      outLines.push(summaryLine);
    }
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

    // Countdown before auto-resume
    if (opts.resume !== false) {
      console.log();

      const barWidth = 50;
      const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let spinnerIndex = 0;

      for (let i = 5; i > 0; i--) {
        const spinner = spinnerChars[spinnerIndex % spinnerChars.length];
        const progress = (5 - i) / 5;
        const filled = Math.floor(progress * barWidth);
        const progressBar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(barWidth - filled));

        const percentage = Math.floor(progress * 100);
        const timeDisplay = i === 1 ? '1 second ' : `${i} seconds`;

        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        process.stdout.write(
          `  ${chalk.cyan(spinner)} ` +
          chalk.yellow('RESUMING IN... ') +
          `[${progressBar}] ` +
          chalk.bold.white(`${percentage}% `) +
          chalk.yellow(`(${timeDisplay} remaining) `) +
          chalk.dim('Press Ctrl+C to cancel')
        );

        spinnerIndex++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      console.log(chalk.bold.green('  ✅ RESUMING SESSION NOW!\n'));
    }
  }

  if (process.stdin.isTTY && opts.resume !== false) {
    const args = [
      ...(opts.yolo ? ['--dangerously-skip-permissions'] : []),
      '--resume', sessionId,
      ...(opts.resumeModel ? ['--model', opts.resumeModel] : [])
    ];

    console.log(chalk.dim(`Resuming: claude ${args.join(' ')}\n`));

    const child = spawn('claude', args, { stdio: 'inherit' });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red(`\n'claude' not found. Run manually:`));
        console.error(chalk.white(`  claude ${args.join(' ')}`));
      } else {
        console.error(chalk.red(`\nFailed to start claude: ${err.message}`));
      }
      process.exit(1);
    });

    child.on('close', (code) => process.exit(code ?? 0));
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
  const cwdProject = process.cwd().replace(/[\/\.]/g, '-');
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

async function undo(opts: { dryRun?: boolean }) {
  const cwdProject = process.cwd().replace(/[\/\.]/g, '-');
  const projectDir = join(getClaudeConfigDir(), "projects", cwdProject);

  const sessions = await listSessions(projectDir);
  if (sessions.length === 0) {
    console.error(chalk.red("No sessions found in current project"));
    process.exit(1);
  }

  const latest = sessions[0];
  console.log(chalk.cyan(`Most recent session: ${latest.id}`));
  console.log(chalk.dim(`Modified: ${latest.modifiedAt.toLocaleString()}`));
  console.log();

  await restore(latest.id, opts);
}