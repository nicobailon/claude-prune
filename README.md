# claude-prune

A fast CLI tool for pruning Claude Code sessions.

## Features

- **Smart Pruning**: Keep messages by count (`--keep 10`) or percentage (`--keep-percent 25`)
- **AI Summarization**: Automatically generates a summary of pruned content (enabled by default)
- **Safe by Default**: Always preserves session summaries and metadata
- **Auto Backup**: Creates timestamped backups before modifying files
- **Restore Support**: Easily restore from backups with the `restore` command
- **Dry-Run Preview**: Preview changes and summary before committing

## Installation

### Run directly (recommended)

```bash
# Using npx (Node.js)
npx claude-prune <sessionId> --keep 50

# Using bunx (Bun)
bunx claude-prune <sessionId> --keep 50
```

### Install globally

```bash
# Using npm
npm install -g claude-prune

# Using bun
bun install -g claude-prune
```

## Quick Start

**Step-by-step workflow:**

1. **In Claude Code**, run `/status` to find your Session ID:
   ```
   Session ID: 03953bb8-6855-4e53-a987-e11422a03fc6
   ```

2. **Quit Claude Code** (Ctrl+C or type `/quit`)

3. **Run prune** from the same project directory:
   ```bash
   npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 10
   ```

4. **Resume Claude Code** and select your session:
   ```bash
   claude --resume
   ```
   Use arrow keys to find your pruned session in the list.

## Usage

```bash
claude-prune prune <sessionId> --keep <number> [options]
claude-prune prune <sessionId> --keep-percent <percent> [options]
claude-prune restore <sessionId> [--dry-run]

# Shorthand (prune is default)
claude-prune <sessionId> --keep <number> [options]
claude-prune <sessionId> --keep-percent <percent> [options]
```

### Arguments

- `sessionId`: UUID of the Claude Code session (find it via `/status` in Claude Code)

### Options

| Option | Description |
|--------|-------------|
| `-k, --keep <number>` | Number of assistant messages to keep |
| `-p, --keep-percent <number>` | Percentage of assistant messages to keep (1-100) |
| `--dry-run` | Preview changes and summary without modifying files |
| `--no-summary` | Skip AI summarization of pruned messages |
| `--summary-model <model>` | Model for summarization (haiku, sonnet, or full name) |
| `-h, --help` | Show help information |
| `-V, --version` | Show version number |

Either `--keep` or `--keep-percent` is required. If both are provided, `--keep` takes priority.

### Examples

```bash
# Keep the last 10 assistant messages (auto-generates summary of pruned content)
npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 10

# Keep the latest 25% of assistant messages (prunes older 75%)
npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep-percent 25

# Preview what would be pruned (shows summary preview too)
npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 5 --dry-run

# Skip summarization for faster pruning
npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 10 --no-summary

# Use a specific model for summarization (haiku is faster/cheaper)
npx claude-prune 03953bb8-6855-4e53-a987-e11422a03fc6 --keep 10 --summary-model haiku

# Restore from the latest backup
npx claude-prune restore 03953bb8-6855-4e53-a987-e11422a03fc6
```

## How It Works

1. **Locates Session File**: Finds `$CLAUDE_CONFIG_DIR/projects/{project-path}/{sessionId}.jsonl`
2. **Preserves Critical Data**: Always keeps the first line (session summary/metadata)
3. **Smart Pruning**: Finds the Nth-to-last assistant message and keeps everything from that point forward
4. **AI Summarization**: Generates a concise summary of pruned content using Claude CLI
5. **Preserves Context**: Keeps all non-message lines (tool results, system messages)
6. **Safe Backup**: Creates backup in `prune-backup/` before modifying
7. **Interactive Confirmation**: Asks for confirmation unless using `--dry-run`

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

By default, claude-prune looks for session files in `~/.claude`. If Claude Code is configured to use a different directory, you can specify it with the `CLAUDE_CONFIG_DIR` environment variable:

```bash
CLAUDE_CONFIG_DIR=/custom/path/to/claude claude-prune <sessionId> --keep 50
```

## Migrating from v1.x

v2.0 changes the default behavior: **summarization is now enabled by default**.

```bash
# v1.x (summary was opt-in)
claude-prune <id> -k 10 --summarize-pruned

# v2.0 (summary is default, opt-out with --no-summary)
claude-prune <id> -k 10              # includes summary
claude-prune <id> -k 10 --no-summary # skips summary
```

The `--summarize-pruned` flag has been removed. Use `--no-summary` to disable summarization.

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

## License

MIT
