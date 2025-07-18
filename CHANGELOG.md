# Changelog

## [1.2.0] - 2024-XX-XX
### Added
- New `--summarize-pruned` flag for the `prune` command that generates a summary of removed messages using Claude CLI
- Summary is prepended to the session as a special message with `isCompactSummary: true` flag
- Automatic detection and handling of missing Claude CLI with helpful error messages
- Timeout protection (30s) for summarization calls

### Changed
- Updated `pruneSessionLines` function to return dropped message content
- Enhanced command descriptions to mention summarization capability

### Technical
- Added `droppedMessages` to the return type of `pruneSessionLines`
- Shell injection protection using single-quote escaping
- Dry-run mode now skips summarization attempts