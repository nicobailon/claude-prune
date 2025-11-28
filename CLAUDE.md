# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ccprune** - CLI tool that prunes Claude Code session transcript files (`.jsonl`) to reduce context usage. Operates on session files at `$CLAUDE_CONFIG_DIR/projects/{project-path-with-hyphens}/{sessionId}.jsonl` (where `$CLAUDE_CONFIG_DIR` defaults to `~/.claude` if not set).

Fork of [claude-prune](https://github.com/DannyAziz/claude-prune) with enhanced features.

**v2.x**: Summarization enabled by default, zero-config default (20%), summary synthesis on re-prune.

## Essential Commands

```bash
# Development
bun install                    # Install dependencies
bun run test                   # Run all tests (uses Vitest via npm script)
bun run test -- --watch        # Run tests in watch mode
bun run test -- --coverage     # Run tests with coverage
bun run test src/index.test.ts # Run a single test file
bun run build                  # Build for distribution

# Testing the CLI locally
bun run src/index.ts                                      # Auto-detect latest session, prune 20%
bun run src/index.ts --pick                               # Interactive session picker
bun run src/index.ts -n                                   # Prune only, don't resume
bun run src/index.ts <sessionId> -k 10                    # Prune specific session by count
bun run src/index.ts <sessionId> -p 25                    # Prune by percentage (keep 25%)
bun run src/index.ts --no-summary                         # Skip summary
bun run src/index.ts --summary-model haiku                # Use haiku model
bun run src/index.ts restore <sessionId>                  # Test restore command
./dist/index.js --help                                    # Test built CLI
```

## Architecture

Single-file CLI: all core logic in `src/index.ts` with functions exported for testing. Tests co-located as `src/*.test.ts`.

**`getClaudeConfigDir()`** - Returns Claude config directory:
- Checks `CLAUDE_CONFIG_DIR` env var, falls back to `~/.claude`

**`countAssistantMessages(lines)`** - Pre-scan for percentage calculation:
- Counts assistant messages in lines (skips first line)
- Used to calculate keepN from `--keep-percent`

**`extractMessageContent(content)`** - Extracts text from message content:
- Handles string content directly
- Handles array content with multiple block types: `text`, `tool_result`, `thinking`, `tool_use`
- Returns `[Used tool: ToolName]` for tool_use blocks (for summary context)
- Filters empty results and joins with `\n\n`

**`pruneSessionLines(lines, keepN)`** - Main pruning algorithm:
1. Preserves first line (file-history-snapshot or session metadata)
2. Finds assistant message indices, keeps everything from Nth-to-last assistant message forward
3. Preserves non-message lines (tool results, file-history-snapshots)
4. **Cache Token Hack**: Zeros out the last non-zero `cache_read_input_tokens` in `usage` or `message.usage` objects to reduce UI context percentage display
5. Returns `droppedMessages[]` with `isSummary` flag for each message (detects `isCompactSummary: true`)

**`generateSummary(droppedMessages, options)`** - AI summarization:
- Separates existing summary (`isSummary: true`) from chat messages
- **Summary Synthesis**: If existing summary found, uses special prompt to synthesize old summary + new messages
- **Edge Case**: If only summary dropped (no chat), returns it unchanged
- **Structured Output**: Generates summary with 5 sections (Overview, What Was Accomplished, Files Modified, Key Technical Details, Current State & Pending Work)
- Formats transcript with proper labels (User/Assistant/System)
- Truncates at `maxLength` (default 60K chars) to avoid issues
- Uses stdin to pipe prompt to `claude -p` CLI (no shell escaping needed)
- Supports `--model` option for model selection (haiku, sonnet, or full name)
- Returns summary starting with "Previously, we discussed..."
- Result appended as `{ type: "user", isCompactSummary: true, message: {...} }` at end of session

**`listSessions(projectDir)`** - Session discovery:
- Lists all UUID-format `.jsonl` files in project directory
- Filters out agent sessions (non-UUID filenames)
- Returns sorted by modification time (newest first)
- Includes id, path, modifiedAt, sizeKB for each session

**`findLatestSession(projectDir)`** - Returns most recently modified session or null

**`findLatestBackup(backupFiles, sessionId)`** - Backup discovery:
- Filters by pattern `{sessionId}.jsonl.{timestamp}`
- Filters out NaN timestamps, sorts descending

**Project Path Resolution**: `/Users/alice/project` becomes `-Users-alice-project` via `process.cwd().replace(/\//g, '-')`

**Backup Strategy**: Creates backups in `prune-backup/` subdirectory as `{sessionId}.jsonl.{timestamp}` before modifications.

**CLI Commands**:
- `ccprune` - Auto-detect latest session, prune (20% default), and resume automatically
- `ccprune --pick` - Interactive session picker
- `ccprune -n` / `--no-resume` - Prune only, don't resume
- `ccprune <sessionId>` - Prune specific session
- `ccprune <sessionId> -k <n>` - Prune by message count
- `ccprune <sessionId> -p <percent>` - Prune by percentage (1-100)
- `ccprune restore <sessionId>` - Restore from latest backup
- Options: `--no-summary`, `--summary-model <model>`, `--dry-run`
- Priority: `-k` > `-p` > default 20%
- `--no-summary` with existing summary: preserves existing summary as-is

## Key Implementation Details

- **Message Detection**: `MSG_TYPES = new Set(["user", "assistant", "system"])` distinguishes message objects from metadata/tool results
- **Safe Parsing**: All JSON parsing wrapped in try/catch for mixed content files
- **Interactive Confirmation**: Uses `@clack/prompts` unless `--dry-run` specified
- **Output Format**: JSONL with `\n` line endings
- **Dry-Run Preview**: Shows summary that would be inserted without writing files
