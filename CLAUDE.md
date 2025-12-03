# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ccprune** - CLI tool that prunes Claude Code session transcript files (`.jsonl`) to reduce context usage. Operates on session files at `$CLAUDE_CONFIG_DIR/projects/{project-path-with-hyphens}/{sessionId}.jsonl` (where `$CLAUDE_CONFIG_DIR` defaults to `~/.claude` if not set).

Fork of [claude-prune](https://github.com/DannyAziz/claude-prune) with token-based pruning, AI summarization, and auto-resume.

## Essential Commands

```bash
# Development
bun install                    # Install dependencies
bun run test                   # Run all tests (Vitest)
bun run test -- --watch        # Tests in watch mode
bun run test src/index.test.ts # Single test file
bun run build                  # Build for distribution

# Testing the CLI locally
bun run src/index.ts                              # Auto-detect, prune to 40K tokens, auto-resume
bun run src/index.ts --pick                       # Interactive session picker
bun run src/index.ts -n                           # Prune only, don't resume
bun run src/index.ts --dry-run                    # Preview changes without writing
bun run src/index.ts --no-summary                 # Skip AI summarization
bun run src/index.ts restore <sessionId>          # Restore from backup
bun run src/index.ts undo                         # Undo last prune (restore most recent session)
./dist/index.js --help                            # Test built CLI
```

## Architecture

Single-file CLI in `src/index.ts` with all core logic exported for testing. Tests in `src/*.test.ts`. Summarization logic separated into `src/generateSummary.ts`.

### Token Counting (`countSessionTokens`)

Core function for accurate token calculation:
- Uses Claude's cumulative usage data from last message: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- Falls back to character-based estimation (chars/4) for messages without usage data
- Returns `{ total, perLine: Map<lineIndex, tokens>, breakdown }`
- Per-line tokens are proportionally scaled to match the cumulative total

### Pruning Algorithm (`pruneSessionLines`)

1. Preserves first line (session metadata with `leafUuid`)
2. Scans right-to-left accumulating tokens until threshold reached
3. Preserves non-message lines (file-history-snapshots, tool results)
4. Calls `cleanOrphanedToolResults()` to remove tool_results referencing pruned tool_use blocks
5. Updates `leafUuid` in first line to point to last kept message (critical for Claude Code to recognize conversation chain)
6. Zeros out last non-zero `cache_read_input_tokens` (cache token hack for UI display)

### Orphan Cleanup (`cleanOrphanedToolResults`)

Removes orphaned `tool_result` blocks from the first user message with array content:
- Skips `isCompactSummary` messages (continue, don't break)
- Does NOT break on assistant messages (previous bug)
- Called both in `pruneSessionLines()` and in the "under threshold" early exit path

### Summary Generation (`generateSummary`)

- Separates existing summary (`isSummary: true`) from chat messages
- **Summary Synthesis**: If existing summary found, synthesizes old + new into one
- Uses stdin to pipe prompt to summarization backend (Gemini API or Claude Code CLI)
- Result appended as `{ type: "user", isCompactSummary: true, message: {...} }`

### CLI Commands

| Command | Description |
|---------|-------------|
| `ccprune` | Auto-detect latest session, prune to 40K tokens, auto-resume |
| `ccprune --pick` | Interactive session picker |
| `ccprune -n` | Prune only, don't resume |
| `ccprune restore <id>` | Restore session from latest backup |
| `ccprune undo` | Restore most recent session from backup |

Key options: `--keep <tokens>`, `--dry-run`, `--no-summary`, `--yolo`, `--resume-model <model>`

## Key Implementation Details

- **Message Detection**: `MSG_TYPES = new Set(["user", "assistant", "system"])`
- **Project Path**: `/Users/alice/project` becomes `-Users-alice-project`
- **Backup Strategy**: `prune-backup/{sessionId}.jsonl.{timestamp}`
- **Commander.js**: Uses `enablePositionalOptions()` to handle subcommand options (prevents conflicts with main program's `--dry-run`)
- **Safe Parsing**: All JSON parsing wrapped in try/catch
- **Default Threshold**: 40K tokens (results in ~55K total after Claude Code adds system context)
