# Plan: Fix Orphan Cleanup Breaking on Assistant Messages (v4.1.3)

## Problem
API error on resume: `unexpected tool_use_id found in tool_result blocks`

## Root Cause (TWO bugs found)

### Bug 1: Cleanup breaks on assistant messages before reaching user with orphan
The orphan cleanup loop has:
```typescript
if (MSG_TYPES.has(obj.type)) break;  // BREAKS on any message type!
```

When there's an **assistant message** between the compact summary and the user message with orphan tool_results, the loop breaks early and never cleans the orphan.

**Evidence** (backup file structure):
- Line 12: compact summary (`isCompactSummary: true`)
- Line 13: assistant message → loop BREAKS here!
- ...
- Line 252: user with orphan `tool_result` → NEVER REACHED

### Bug 2: Cleanup doesn't run when under threshold
When session is already under 40K tokens, ccprune skips pruning entirely and the cleanup code (inside `pruneSessionLines()`) never runs.

## Solution

### Fix 1: Remove premature break on message types
Remove `if (MSG_TYPES.has(obj.type)) break;` - let loop continue until it finds a user message with array content.

### Fix 2: Run cleanup unconditionally
Extract cleanup into separate function, call it even when skipping compaction.

## Implementation

### File: `src/index.ts`

**1. Extract and fix orphan cleanup function** (~line 270):

```typescript
export function cleanOrphanedToolResults(lines: string[]): string[] {
  const result = [...lines];

  for (let i = 1; i < result.length; i++) {
    try {
      const obj = JSON.parse(result[i]);
      if (obj.isCompactSummary) continue;
      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        const filtered = obj.message.content.filter(
          (block: any) => block.type !== 'tool_result'
        );
        if (filtered.length === 0) {
          result.splice(i, 1);
        } else if (filtered.length !== obj.message.content.length) {
          obj.message.content = filtered;
          result[i] = JSON.stringify(obj);
        }
        break;  // Stop after cleaning first user message with array content
      }
      // REMOVED: if (MSG_TYPES.has(obj.type)) break;
      // This was causing premature exit on assistant messages
    } catch {}
  }

  return result;
}
```

**2. Call cleanup in "under threshold" early exit** (~line 920):

```typescript
if (totalTokens <= keepTokens) {
  console.log();
  console.log(chalk.green(`Session has ${totalTokens.toLocaleString()} tokens (under ${keepTokens.toLocaleString()} threshold) - no compaction needed`));

  // Still clean orphaned tool_results even without compaction
  const cleanedLines = cleanOrphanedToolResults(lines);
  if (cleanedLines.length !== lines.length || cleanedLines.some((l, i) => l !== lines[i])) {
    writeFileSync(sessionPath, cleanedLines.join('\n') + '\n');
    console.log(chalk.yellow('Cleaned orphaned tool_results'));
  }

  // ... rest of early exit (auto-resume)
}
```

**3. Update pruneSessionLines** (~line 393):

Replace inline orphan cleanup loop with:
```typescript
// Clean up orphaned tool_results
const cleanedOutLines = cleanOrphanedToolResults(outLines);
outLines.length = 0;
outLines.push(...cleanedOutLines);
```

### File: `src/index.test.ts`

```typescript
describe('cleanOrphanedToolResults', () => {
  it('removes orphaned tool_results even when assistant messages come first', () => {
    const lines = [
      JSON.stringify({ type: "summary", leafUuid: "a1" }),
      JSON.stringify({ type: "user", isCompactSummary: true, uuid: "sum", message: { content: "summary" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "response" }] } }),
      JSON.stringify({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "more" }] } }),
      JSON.stringify({ type: "user", uuid: "u1", message: { content: [
        { type: "tool_result", tool_use_id: "orphan", content: "result" }
      ] } }),
    ];

    const result = cleanOrphanedToolResults(lines);

    // User message with only tool_result should be removed
    expect(result.length).toBe(4);
    expect(result.some(l => l.includes('orphan'))).toBe(false);
  });

  it('preserves text content when removing tool_results', () => {
    const lines = [
      JSON.stringify({ type: "summary", leafUuid: "a1" }),
      JSON.stringify({ type: "user", uuid: "u1", message: { content: [
        { type: "tool_result", tool_use_id: "orphan", content: "result" },
        { type: "text", text: "user message" }
      ] } }),
    ];

    const result = cleanOrphanedToolResults(lines);
    const userMsg = JSON.parse(result[1]);

    expect(userMsg.message.content).toHaveLength(1);
    expect(userMsg.message.content[0].type).toBe('text');
  });
});
```

## Version
Bump to **4.1.3** (patch - bug fix)

## Testing
1. Run test suite with new tests
2. Test on backup file with assistant messages between compact summary and orphan
3. Verify orphan is cleaned
4. Verify Claude Code resume works without API error
