# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a CLI tool that prunes Claude Code session transcript files (`.jsonl`) to reduce context usage. The tool operates on session files stored in `$CLAUDE_CONFIG_DIR/projects/{project-path-with-hyphens}/{sessionId}.jsonl` (where `$CLAUDE_CONFIG_DIR` defaults to `~/.claude` if not set).

## Essential Commands

```bash
# Development
bun install                    # Install dependencies
bun test                      # Run all tests
bun test --watch              # Run tests in watch mode  
bun test --coverage           # Run tests with coverage
bun run build                 # Build for distribution

# Testing the CLI locally
bun run src/index.ts prune <sessionId> -k 10   # Test prune command
bun run src/index.ts restore <sessionId>       # Test restore command
./dist/index.js --help                         # Test built CLI

# Single test file
bunx vitest src/index.test.ts
```

## Architecture

**Core Logic**: The `pruneSessionLines()` function (exported for testing) contains the main pruning algorithm that:
1. Always preserves the first line (session metadata/summary)
2. Finds assistant message indices and keeps everything from the Nth-to-last assistant message forward
3. Preserves all non-message lines (tool results, system diagnostics)
4. **Cache Token Hack**: Zeros out the last non-zero `cache_read_input_tokens` to reduce UI context percentage

**Restore Logic**: The `findLatestBackup()` function (exported for testing) handles backup file discovery:
1. Filters files by session ID pattern (`{sessionId}.jsonl.{timestamp}`)
2. Filters out malformed timestamps (NaN values)
3. Sorts by timestamp and returns the most recent backup

**Project Path Resolution**: Claude Code stores projects using hyphenated absolute paths (e.g., `/Users/alice/project` becomes `-Users-alice-project`), handled by `process.cwd().replace(/\//g, '-')`.

**Backup Strategy**: Creates backups in `prune-backup/` subdirectory with format `{sessionId}.jsonl.{timestamp}` before modifications.

**CLI Commands**: 
- `claude-prune prune <sessionId> -k <n>` - Main pruning functionality
- `claude-prune restore <sessionId>` - Restore from latest backup
- Backward compatibility: `claude-prune <sessionId> -k <n>` still works

**Testing**: Comprehensive test suite in `src/index.test.ts` covers edge cases, message counting, core pruning logic, and restore functionality. All CLI logic is extracted into testable functions.

## Key Implementation Details

- **Message Detection**: Uses `MSG_TYPES = ["user", "assistant", "system"]` set for identifying message objects vs metadata
- **Safe Parsing**: All JSON parsing is wrapped in try/catch to handle mixed content files
- **Interactive Confirmation**: Uses `@clack/prompts` for user confirmation unless `--dry-run` is specified
- **Output Format**: Maintains exact JSONL formatting with proper line endings