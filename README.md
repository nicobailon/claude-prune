# ccprune

Next time your Claude Code context is running low, just quit cc then run `npx ccprune` - it auto-resumes you back into your last thread, now compacted with an intelligent rolling summary. Run it again when you're low again - the summaries stack, so context just keeps rolling forward.

> Fork of [claude-prune](https://github.com/DannyAziz/claude-prune) with enhanced features: percentage-based pruning, AI summarization enabled by default, and improved UX.

## Features

- **Zero-Config Default**: Just run `ccprune` - auto-detects latest session, keeps 55K tokens
- **Token-Based Pruning**: Prunes based on actual token count, not message count
- **Smart Threshold**: Automatically skips pruning if session is under 55K tokens
- **AI Summarization**: Automatically generates a summary of pruned content (enabled by default)
- **Summary Synthesis**: Re-pruning synthesizes old summary + new pruned content into one cohesive summary
- **Small Session Warning**: Prompts for confirmation when auto-selecting sessions with < 5 messages
- **Safe by Default**: Always preserves session summaries and metadata
- **Auto Backup**: Creates timestamped backups before modifying files
- **Restore Support**: Easily restore from backups with the `restore` command
- **Dry-Run Preview**: Preview changes and summary before committing

## Installation

### Run directly (recommended)

```bash
# Using npx (Node.js)
npx ccprune <sessionId> --keep 50

# Using bunx (Bun)
bunx ccprune <sessionId> --keep 50
```

### Install globally

```bash
# Using npm
npm install -g ccprune

# Using bun
bun install -g ccprune
```

## Quick Start

1. **Quit Claude Code** - Press `Ctrl+C` or type `/quit`

2. **Run prune** from the same project directory:
   ```bash
   npx ccprune
   ```

That's it! ccprune auto-detects your latest session, prunes old messages (keeping a summary), and resumes automatically.

## Setup (Recommended)

For fast, high-quality summarization, set up a Gemini API key:

1. Get a free key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Add to your shell profile (~/.zshrc or ~/.bashrc):
   ```bash
   export GEMINI_API_KEY=your_key
   ```
3. Restart your terminal or run `source ~/.zshrc`

With `GEMINI_API_KEY` set, ccprune automatically uses Gemini 2.5 Flash for fast summarization without chunking.

## Usage

```bash
# Zero-config: auto-detects latest session, keeps 55K tokens
ccprune

# Pick from available sessions interactively
ccprune --pick

# Explicit session ID (if you need a specific session)
ccprune <sessionId>

# Explicit token limit
ccprune --keep 40000
ccprune --keep-tokens 80000

# Subcommands
ccprune restore <sessionId> [--dry-run]
```

### Arguments

- `sessionId`: (Optional) UUID of the Claude Code session. Auto-detects latest if omitted.

### Options

| Option | Description |
|--------|-------------|
| `--pick` | Interactively select from available sessions |
| `-n, --no-resume` | Skip automatic session resume |
| `--yolo` | Resume with `--dangerously-skip-permissions` |
| `-k, --keep <number>` | Number of tokens to retain (default: 55000) |
| `--keep-tokens <number>` | Number of tokens to retain (alias for `-k`) |
| `--dry-run` | Preview changes and summary without modifying files |
| `--no-summary` | Skip AI summarization of pruned messages |
| `--summary-model <model>` | Model for summarization (haiku, sonnet, or full name) |
| `--summary-timeout <ms>` | Timeout for summarization in milliseconds (default: 360000) |
| `--gemini` | Use Gemini 3 Pro for summarization |
| `--gemini-flash` | Use Gemini 2.5 Flash for summarization |
| `--claude-code` | Use Claude Code CLI for summarization (chunks large transcripts) |
| `-h, --help` | Show help information |
| `-V, --version` | Show version number |

If no session ID is provided, auto-detects the most recently modified session. If no keep option is specified, defaults to 55,000 tokens.

**Default summarization:**
- With `GEMINI_API_KEY` set: Gemini 2.5 Flash (fast, no chunking)
- Without API key: Claude Code CLI (with chunking for large transcripts)

### Examples

```bash
# Simplest: auto-detect, prune, and resume automatically
npx ccprune

# Prune only (don't resume)
npx ccprune -n

# Resume in yolo mode (--dangerously-skip-permissions)
npx ccprune --yolo

# Pick from available sessions interactively
npx ccprune --pick

# Keep 40K tokens (more aggressive pruning)
npx ccprune --keep 40000

# Keep 80K tokens (less aggressive pruning)
npx ccprune --keep-tokens 80000

# Preview what would be pruned (shows summary preview too)
npx ccprune --dry-run

# Skip summarization for faster pruning
npx ccprune --keep 55000 --no-summary

# Use Claude Code CLI with haiku model (faster/cheaper)
npx ccprune --claude-code --summary-model haiku

# Use Gemini 3 Pro for summarization
npx ccprune --gemini

# Use Gemini 2.5 Flash (default when GEMINI_API_KEY is set)
npx ccprune --gemini-flash

# Force Claude Code CLI for summarization
npx ccprune --claude-code

# Target a specific session by ID
npx ccprune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 40000

# Restore from the latest backup
npx ccprune restore 03953bb8-6855-4e53-a987-e11422a03fc6
```

## How It Works

```
BEFORE                 AFTER FIRST PRUNE           AFTER RE-PRUNE
──────                 ────────────────            ──────────────
┌───────────────┐      ┌───────────────┐           ┌───────────────┐
│ msg 1 (old)   │─┐    │ [SUMMARY]     │─┐         │ [NEW SUMMARY] │ ◄─ synthesized
│ msg 2 (old)   │ │    │ "Previously.."│ │         │ (old+middle)  │
│ ...           │ ├──► ├───────────────┤ │         ├───────────────┤
│ msg N (old)   │─┘    │ msg N+1 (kept)│ ├───────► │ msg X (kept)  │
├───────────────┤      │ msg N+2 (kept)│ │         │ msg Y (kept)  │
│ msg N+1 (new) │─────►│ msg N+3 (kept)│─┘         │ msg Z (kept)  │
│ msg N+2 (new) │      └───────────────┘           └───────────────┘
│ msg N+3 (new) │
└───────────────┘       ▲                           ▲
                        │                           │
                   old msgs become             old summary + middle
                   summary, recent kept        synthesized, recent kept
```

1. **Locates Session File**: Finds `$CLAUDE_CONFIG_DIR/projects/{project-path}/{sessionId}.jsonl`
2. **Counts Tokens**: Calculates total tokens in session using `message.usage.output_tokens` (with content-based fallback)
3. **Early Exit**: If total tokens ≤ threshold (55K default), skips pruning and auto-resumes
4. **Preserves Critical Data**: Always keeps the first line (file-history-snapshot or session metadata)
5. **Token-Based Cutoff**: Scans right-to-left, accumulating tokens until reaching threshold, then prunes everything before that point
6. **Lenient Boundary**: Includes one extra message at the boundary to preserve more context
7. **Content Extraction**: Extracts text from messages, including `tool_result` outputs and `thinking` blocks. Tool calls become `[Used tool: ToolName]` placeholders to provide context without verbose tool I/O
8. **Orphan Cleanup**: Removes `tool_result` blocks in kept messages that reference `tool_use` blocks from pruned messages
9. **AI Summarization**: Generates a structured summary with sections: Overview, What Was Accomplished, Files Modified, Key Technical Details, Current State & Pending Work
10. **Summary Synthesis**: Re-pruning synthesizes old summary + new pruned content into one cohesive summary
11. **Chunked Summarization**: Large transcripts (>30KB) are chunked and summarized in parts when using `--claude-code`
12. **Safe Backup**: Creates timestamped backup in `prune-backup/` before modifying
13. **Auto-Resume**: Optionally resumes Claude Code session after pruning

## File Structure

Claude Code stores sessions in:

```
~/.claude/projects/{project-path-with-hyphens}/{sessionId}.jsonl
```

For example, a project at `/Users/alice/my-app` becomes:

```
~/.claude/projects/-Users-alice-my-app/{sessionId}.jsonl
```

## Environment Variables

### CLAUDE_CONFIG_DIR

By default, ccprune looks for session files in `~/.claude`. If Claude Code is configured to use a different directory, you can specify it with the `CLAUDE_CONFIG_DIR` environment variable:

```bash
CLAUDE_CONFIG_DIR=/custom/path/to/claude ccprune <sessionId> --keep 50
```

### GEMINI_API_KEY

When set, ccprune automatically uses Gemini 2.5 Flash for summarization (recommended). Get your free API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
export GEMINI_API_KEY=your_api_key_here
ccprune  # automatically uses Gemini 2.5 Flash
```

Use `--gemini` for Gemini 3 Pro, or `--claude-code` to force Claude Code CLI.

## Migrating from claude-prune

If you were using the original `claude-prune` package, `ccprune` v3.x has these changes:

```bash
# claude-prune v1.x (message-count based, summary was opt-in)
claude-prune <id> -k 10 --summarize-pruned

# ccprune v2.x (percentage-based, summary enabled by default)
ccprune <id>                    # defaults to 20% of messages
ccprune <id> --keep-percent 25  # keep latest 25% of messages

# ccprune v3.x (token-based, summary enabled by default)
ccprune <id>                    # defaults to 55K tokens
ccprune <id> -k 40000           # keep 40K tokens
ccprune <id> --keep-tokens 80000 # keep 80K tokens
```

**Key changes in v3.x:**
- **Token-based pruning**: `-k` now means tokens, not message count
- **Removed**: `-p, --keep-percent` flag (replaced by token-based approach)
- **Auto-skip**: Sessions under 55K tokens are not pruned
- **Lenient boundary**: Includes one extra message at the boundary to preserve context
- Summary is enabled by default (use `--no-summary` to disable)
- Re-pruning synthesizes old summary + new pruned content into one summary

## Development

```bash
# Clone and install
git clone https://github.com/nicobailon/claude-prune.git
cd claude-prune
bun install

# Run tests
bun run test

# Build
bun run build

# Test locally
./dist/index.js --help
```

## Credits

This project is a fork of [claude-prune](https://github.com/DannyAziz/claude-prune) by Danny Aziz. Thanks for the original implementation!

## License

MIT
