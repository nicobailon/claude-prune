# ccprune

Next time your Claude Code context is running low, just quit cc then run `npx ccprune` - it auto-resumes you back into your last thread, now compacted with an intelligent rolling summary. Run it again when you're low again - the summaries stack, so context just keeps rolling forward.

> Fork of [claude-prune](https://github.com/DannyAziz/claude-prune) with enhanced features: percentage-based pruning, AI summarization enabled by default, and improved UX.

## Features

- **Zero-Config Default**: Just run `ccprune` - auto-detects latest session, keeps 20% of messages
- **Smart Pruning**: Keep messages by count (`--keep 10`) or percentage (`--keep-percent 25`)
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

## Usage

```bash
# Zero-config: auto-detects latest session, keeps 20% of messages
ccprune

# Pick from available sessions interactively
ccprune --pick

# Explicit session ID (if you need a specific session)
ccprune <sessionId>

# Explicit options
ccprune --keep <number>
ccprune --keep-percent <percent>

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
| `-k, --keep <number>` | Number of assistant messages to keep |
| `-p, --keep-percent <number>` | Percentage of assistant messages to keep (1-100) |
| `--dry-run` | Preview changes and summary without modifying files |
| `--no-summary` | Skip AI summarization of pruned messages |
| `--summary-model <model>` | Model for summarization (haiku, sonnet, or full name) |
| `--summary-timeout <ms>` | Timeout for summarization in milliseconds (default: 360000) |
| `--gemini` | Use Gemini 3 Pro for summarization (requires `GEMINI_API_KEY`) |
| `--gemini-flash` | Use Gemini 2.5 Flash for summarization (requires `GEMINI_API_KEY`) |
| `-h, --help` | Show help information |
| `-V, --version` | Show version number |

If no session ID is provided, auto-detects the most recently modified session. If no keep option is specified, defaults to `--keep-percent 20`.

### Examples

```bash
# Simplest: auto-detect, prune, and resume automatically
npx ccprune

# Prune only (don't resume)
npx ccprune -n

# Pick from available sessions interactively
npx ccprune --pick

# Keep the last 10 assistant messages
npx ccprune --keep 10

# Keep the latest 25% of assistant messages
npx ccprune --keep-percent 25

# Preview what would be pruned (shows summary preview too)
npx ccprune --dry-run

# Skip summarization for faster pruning
npx ccprune --keep 10 --no-summary

# Use haiku model for summarization (faster/cheaper)
npx ccprune --summary-model haiku

# Use Gemini API for summarization (no chunking, handles large contexts)
npx ccprune --gemini

# Use Gemini 2.5 Flash for faster summarization
npx ccprune --gemini-flash

# Target a specific session by ID
npx ccprune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 10

# Restore from the latest backup
npx ccprune restore 03953bb8-6855-4e53-a987-e11422a03fc6
```

## How It Works

1. **Locates Session File**: Finds `$CLAUDE_CONFIG_DIR/projects/{project-path}/{sessionId}.jsonl`
2. **Preserves Critical Data**: Always keeps the first line (file-history-snapshot or session metadata)
3. **Smart Pruning**: Finds the Nth-to-last assistant message and keeps everything from that point forward
4. **AI Summarization**: Generates a structured summary of pruned content (files modified, accomplishments, pending work, key technical details)
5. **Summary Synthesis**: When re-pruning a session that already has a summary, synthesizes the old summary + newly pruned messages into one cohesive summary
6. **Chunked Summarization**: For very large transcripts (>30KB with Claude), automatically chunks and summarizes in parts, then combines into a single summary
7. **Gemini Integration**: Optional `--gemini` flag uses Gemini API for summarization (handles large contexts without chunking)
8. **Preserves Context**: Keeps all non-message lines (tool results, file-history-snapshots)
9. **Safe Backup**: Creates backup in `prune-backup/` before modifying
10. **Process Management**: Graceful cleanup on Ctrl+C and automatic retry on failures

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

Required when using the `--gemini` flag. Get your API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
export GEMINI_API_KEY=your_api_key_here
ccprune --gemini
```

## Migrating from claude-prune

If you were using the original `claude-prune` package, `ccprune` v2.x has these changes:

```bash
# claude-prune v1.x (summary was opt-in, -k required)
claude-prune <id> -k 10 --summarize-pruned

# ccprune v2.x (zero-config default, summary enabled by default)
ccprune <id>                    # defaults to 20%, includes summary
ccprune <id> -k 10              # explicit count, includes summary
ccprune <id> -k 10 --no-summary # skips summary

# New in ccprune: percentage-based pruning
ccprune <id> --keep-percent 25  # keep latest 25%
```

**Key changes:**
- `-k` or `-p` flags are now optional (defaults to `--keep-percent 20`)
- Summary is enabled by default (use `--no-summary` to disable)
- Re-pruning synthesizes old summary + new pruned content into one summary
- `--summarize-pruned` flag removed (summary is always on unless `--no-summary`)

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
