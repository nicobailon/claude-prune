# claude-prune

A fast CLI tool for pruning Claude Code sessions.

## Features

- **Smart Pruning**: Keep messages since the last N assistant responses
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

## Usage

```bash
claude-prune prune <sessionId> --keep <number> [options]
claude-prune restore <sessionId> [--dry-run]

# Shorthand (prune is default)
claude-prune <sessionId> --keep <number> [options]
```

### Arguments

- `sessionId`: UUID of the Claude Code session (without .jsonl extension)

### Options

| Option | Description |
|--------|-------------|
| `-k, --keep <number>` | Number of assistant messages to keep (required) |
| `--dry-run` | Preview changes and summary without modifying files |
| `--no-summary` | Skip AI summarization of pruned messages |
| `--summary-model <model>` | Model for summarization (haiku, sonnet, or full name) |
| `-h, --help` | Show help information |
| `-V, --version` | Show version number |

### Examples

```bash
# Keep the last 10 assistant messages (auto-generates summary of pruned content)
claude-prune abc123-def456-789 --keep 10

# Preview what would be pruned (shows summary preview too)
claude-prune abc123-def456-789 --keep 5 --dry-run

# Skip summarization for faster pruning
claude-prune abc123-def456-789 --keep 10 --no-summary

# Use a specific model for summarization (haiku is faster/cheaper)
claude-prune abc123-def456-789 --keep 10 --summary-model haiku

# Restore from the latest backup
claude-prune restore abc123-def456-789
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
