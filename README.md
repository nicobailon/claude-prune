# claude-prune

A fast CLI tool for pruning Claude Code sessions.

## Features

- 🎯 **Smart Pruning**: Keep messages since the last N assistant responses
- 🛡️ **Safe by Default**: Always preserves session summaries and metadata
- 💾 **Auto Backup**: Creates timestamped backups before modifying files
- 📝 **Optional Summarization**: Generate AI summaries of pruned content with `--summarize-pruned`
- 🔄 **Restore Support**: Easily restore from backups with the `restore` command

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
claude-prune prune <sessionId> --keep <number> [--dry-run] [--summarize-pruned]
claude-prune restore <sessionId> [--dry-run]

# Backward compatibility
claude-prune <sessionId> --keep <number> [--dry-run] [--summarize-pruned]
```

### Arguments

- `sessionId`: UUID of the Claude Code session (without .jsonl extension)

### Options

- `-k, --keep <number>`: Number of assistant messages to keep (required)
- `--dry-run`: Preview changes without modifying files
- `--summarize-pruned`: Generate a summary of pruned messages and prepend it to the session (requires Claude CLI)
- `-h, --help`: Show help information
- `-V, --version`: Show version number

### Examples

```bash
# Keep the last 10 assistant messages and everything since then
claude-prune abc123-def456-789 --keep 10

# Preview what would be pruned (safe mode)
claude-prune abc123-def456-789 --keep 5 --dry-run

# Minimal pruning - keep only the last assistant message
claude-prune abc123-def456-789 --keep 1

# Keep the last 10 assistant messages and add a summary of the pruned messages
claude-prune prune abc123-def456-789 --keep 10 --summarize-pruned

# Preview what would be pruned with summarization (dry run)
claude-prune prune abc123-def456-789 --keep 10 --summarize-pruned --dry-run

# Backward compatibility: old syntax still works
claude-prune abc123-def456-789 --keep 10 --summarize-pruned
```

## How It Works

1. **Locates Session File**: Finds `~/.claude/projects/{project-path}/{sessionId}.jsonl`
2. **Preserves Critical Data**: Always keeps the first line (session summary/metadata)
3. **Smart Pruning**: Finds the Nth-to-last assistant message and keeps everything from that point forward
4. **Preserves Context**: Keeps all non-message lines (tool results, system messages)
5. **Safe Backup**: Creates `{sessionId}.bak.{timestamp}` before modifying
6. **Interactive Confirmation**: Asks for confirmation unless using `--dry-run`

## File Structure

Claude Code stores sessions in:

```
~/.claude/projects/{project-path-with-hyphens}/{sessionId}.jsonl
```

For example, a project at `/Users/alice/my-app` becomes:

```
~/.claude/projects/-Users-alice-my-app/{sessionId}.jsonl
```

## Development

```bash
# Clone and install
git clone https://github.com/dannyaziz/cc-prune.git
cd cc-prune
bun install

# Run tests
bun test

# Build
bun run build

# Test locally
./dist/index.js --help
```

## License

MIT © Danny Aziz
