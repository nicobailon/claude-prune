import chalk from 'chalk';

const BOX_WIDTH = 80;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function visualLength(text: string): number {
  return stripAnsi(text).length;
}

export interface OriginalStats {
  lines: number;
  userMsgs: number;
  assistantMsgs: number;
  systemMsgs: number;
  sizeKB: number;
}

export interface ResultStats {
  before: {
    lines: number;
    assistantMsgs: number;
    sizeKB: number;
  };
  after: {
    lines: number;
    assistantMsgs: number;
    sizeKB: number;
  };
  summary?: {
    sizeKB: number;
    durationSec: number;
    model?: string;
  };
  backupPath: string;
}

function centerText(text: string, width: number): string {
  const padding = Math.max(0, width - visualLength(text));
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visualLength(text)));
}

function padLeft(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualLength(text))) + text;
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const ellipsis = '...';
  const keep = maxLen - ellipsis.length;
  return ellipsis + path.slice(-keep);
}

function formatBox(title: string, lines: string[]): string {
  const innerWidth = BOX_WIDTH - 4;
  const titleLine = '+' + chalk.dim('-') + chalk.cyan(centerText(` ${title} `, innerWidth)) + chalk.dim('-') + '+';
  const bottomLine = chalk.dim('+' + '-'.repeat(BOX_WIDTH - 2) + '+');

  const contentLines = lines.map(line => {
    const content = padRight(line, innerWidth);
    return chalk.dim('|') + ' ' + content + ' ' + chalk.dim('|');
  });

  return [titleLine, ...contentLines, bottomLine].join('\n');
}

export function formatOriginalStats(stats: OriginalStats): string {
  const line1 = `${chalk.cyan('Lines:')} ${chalk.white(stats.lines.toString().padEnd(8))}  ` +
    `${chalk.cyan('User:')} ${chalk.white(stats.userMsgs.toString().padEnd(6))}  ` +
    `${chalk.cyan('Assistant:')} ${chalk.white(stats.assistantMsgs.toString().padEnd(6))}  ` +
    `${chalk.cyan('System:')} ${chalk.white(stats.systemMsgs.toString())}`;

  const line2 = `${chalk.cyan('Size:')} ${chalk.white(stats.sizeKB + 'KB')}`;

  return formatBox('Original Session', [line1, line2]);
}

function formatChange(before: number, after: number, suffix: string = ''): string {
  const diff = after - before;
  const percent = before > 0 ? Math.round((diff / before) * 100) : 0;
  const sign = diff > 0 ? '+' : '';
  const color = diff < 0 ? chalk.green : (diff > 0 ? chalk.yellow : chalk.white);
  return color(`${sign}${diff}${suffix} (${sign}${percent}%)`);
}

export function formatResultStats(stats: ResultStats): string {
  const col1 = 20;
  const col2 = 12;
  const col3 = 12;
  const col4 = 20;

  const header = chalk.dim(
    padRight('', col1) +
    padLeft('BEFORE', col2) +
    padLeft('AFTER', col3) +
    padLeft('CHANGE', col4)
  );

  const linesRow =
    chalk.cyan(padRight('Lines:', col1)) +
    chalk.white(padLeft(stats.before.lines.toString(), col2)) +
    chalk.white(padLeft(stats.after.lines.toString(), col3)) +
    padLeft(formatChange(stats.before.lines, stats.after.lines), col4);

  const assistantRow =
    chalk.cyan(padRight('Assistant msgs:', col1)) +
    chalk.white(padLeft(stats.before.assistantMsgs.toString(), col2)) +
    chalk.white(padLeft(stats.after.assistantMsgs.toString(), col3)) +
    padLeft(formatChange(stats.before.assistantMsgs, stats.after.assistantMsgs), col4);

  const sizeRow =
    chalk.cyan(padRight('Content size:', col1)) +
    chalk.white(padLeft(stats.before.sizeKB + 'KB', col2)) +
    chalk.white(padLeft(stats.after.sizeKB + 'KB', col3)) +
    padLeft(formatChange(stats.before.sizeKB, stats.after.sizeKB, 'KB'), col4);

  const lines = [header, linesRow, assistantRow, sizeRow];

  if (stats.summary) {
    const modelInfo = stats.summary.model ? ` using ${stats.summary.model}` : '';
    lines.push('');
    lines.push(chalk.cyan('Summary: ') + chalk.white(`${stats.summary.sizeKB}KB generated in ${stats.summary.durationSec}s${modelInfo}`));
  }

  const maxPathLen = BOX_WIDTH - 4 - 8;
  lines.push(chalk.cyan('Backup: ') + chalk.dim(truncatePath(stats.backupPath, maxPathLen)));

  return formatBox('Prune Results', lines);
}

export function countMessageTypes(lines: string[]): { user: number; assistant: number; system: number } {
  const counts = { user: 0, assistant: 0, system: 0 };

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'user' && !parsed.isCompactSummary) counts.user++;
      else if (parsed.type === 'assistant') counts.assistant++;
      else if (parsed.type === 'system') counts.system++;
    } catch {
      // Skip non-JSON lines
    }
  }

  return counts;
}
