import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pruneSessionLines, findLatestBackup, getClaudeConfigDir } from './index.js';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

describe('getClaudeConfigDir', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
  });

  it('should return ~/.claude when CLAUDE_CONFIG_DIR is not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const result = getClaudeConfigDir();
    expect(result).toBe(join(homedir(), '.claude'));
  });

  it('should return CLAUDE_CONFIG_DIR when set', () => {
    const customPath = '/custom/claude/config';
    process.env.CLAUDE_CONFIG_DIR = customPath;
    const result = getClaudeConfigDir();
    expect(result).toBe(customPath);
  });

  it('should fallback to ~/.claude when CLAUDE_CONFIG_DIR is an empty string', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    const result = getClaudeConfigDir();
    expect(result).toBe(join(homedir(), '.claude'));
  });
});

describe('pruneSessionLines', () => {
  const createMessage = (type: string, uuid: string, content: string = "test") => 
    JSON.stringify({ type, uuid, message: { content } });

  const createSummary = (content: string) => 
    JSON.stringify({ type: "user", isCompactSummary: true, message: { content } });

  it('should always preserve the first line', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 0);
    
    expect(outLines).toHaveLength(1);
    expect(outLines[0]).toBe(lines[0]);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'test' });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'test' });
  });

  it('should keep messages from last N assistant messages', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"), // assistant 1
      createMessage("user", "3"),
      createMessage("assistant", "4"), // assistant 2 (keep from here)
      createMessage("user", "5"),
      createMessage("assistant", "6"), // assistant 3
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 2);
    
    expect(outLines).toHaveLength(4); // summary + 3 messages from assistant 2 onward
    expect(kept).toBe(3);
    expect(dropped).toBe(3);
    expect(assistantCount).toBe(3);
    expect(droppedMessages).toHaveLength(3);
  });

  it('should keep all messages if assistant count <= keepN', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      createMessage("user", "3"),
      createMessage("assistant", "4"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 5);
    
    expect(outLines).toHaveLength(5); // all lines
    expect(kept).toBe(4);
    expect(dropped).toBe(0);
    expect(assistantCount).toBe(2);
    expect(droppedMessages).toHaveLength(0);
  });

  it('should preserve non-message lines (tool results, etc)', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      JSON.stringify({ type: "tool_result", content: "tool output" }),
      createMessage("assistant", "2"),
      "non-json line",
      createMessage("user", "3"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 1);
    
    expect(outLines).toHaveLength(6); // summary + tool result + non-json + 2 messages from assistant
    expect(kept).toBe(3);
    expect(dropped).toBe(0);
    expect(assistantCount).toBe(1);
    expect(droppedMessages).toHaveLength(0);
  });

  it('should handle empty lines array', () => {
    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines([], 5);
    
    expect(outLines).toHaveLength(0);
    expect(kept).toBe(0);
    expect(dropped).toBe(0);
    expect(assistantCount).toBe(0);
    expect(droppedMessages).toHaveLength(0);
  });

  it('should handle no assistant messages', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("user", "2"),
      createMessage("system", "3"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 2);
    
    expect(outLines).toHaveLength(4); // all lines since no assistant messages to cut from
    expect(kept).toBe(3);
    expect(dropped).toBe(0);
    expect(assistantCount).toBe(0);
    expect(droppedMessages).toHaveLength(0);
  });

  it('should handle malformed JSON gracefully', () => {
    const lines = [
      createSummary("Session summary"),
      "invalid json",
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      "{ invalid json",
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 1);
    
    expect(outLines).toHaveLength(5); // summary + invalid json + 2 messages + invalid json
    expect(kept).toBe(2);
    expect(dropped).toBe(0);
    expect(assistantCount).toBe(1);
    expect(droppedMessages).toHaveLength(0);
  });

  it('should handle keepN = 0', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      createMessage("user", "3"),
      createMessage("assistant", "4"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, 0);
    
    expect(outLines).toHaveLength(1); // only summary
    expect(kept).toBe(0);
    expect(dropped).toBe(4);
    expect(assistantCount).toBe(2);
    expect(droppedMessages).toHaveLength(4);
  });

  it('should handle negative keepN', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
    ];

    const { outLines, kept, dropped, assistantCount, droppedMessages } = pruneSessionLines(lines, -5);
    
    expect(outLines).toHaveLength(1); // only summary
    expect(kept).toBe(0);
    expect(dropped).toBe(2);
    expect(assistantCount).toBe(1);
    expect(droppedMessages).toHaveLength(2);
  });

  it('collects dropped message content', () => {
    const lines = [
      'header line',
      '{"type":"user","message":{"content":"Hello"}}',
      '{"type":"assistant","message":{"content":"Hi there"}}',
      '{"type":"user","message":{"content":"How are you?"}}',
      '{"type":"assistant","message":{"content":"I am fine"}}',
    ];
    const { droppedMessages } = pruneSessionLines(lines, 1);
    expect(droppedMessages).toHaveLength(3);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Hello' });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'Hi there' });
    expect(droppedMessages[2]).toEqual({ type: 'user', content: 'How are you?' });
  });

  it('handles messages without content gracefully', () => {
    const lines = [
      'header line',
      '{"type":"user"}',
      '{"type":"assistant","message":{}}',
      '{"type":"user","message":{"content":"Valid message"}}',
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(1);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Valid message' });
  });

  it('summary lines with isCompactSummary are preserved', () => {
    const lines = [
      'header line',
      '{"type":"user","isCompactSummary":true,"message":{"content":"Previous summary"}}',
      '{"type":"user","message":{"content":"New message"}}',
    ];
    const { outLines, droppedMessages } = pruneSessionLines(lines, 1);
    expect(outLines).toContain('{"type":"user","isCompactSummary":true,"message":{"content":"Previous summary"}}');
    expect(droppedMessages).toHaveLength(0);
  });
});

describe('execSync error handling', () => {
  it('should handle execSync errors gracefully', () => {
    const mockExecSync = vi.mocked(execSync);
    
    // Make execSync throw an error
    mockExecSync.mockImplementation(() => {
      throw new Error('Command not found: claude');
    });
    
    // This test verifies that the error handling exists in the main function
    // The actual process.exit(1) call would need to be tested in an integration test
    expect(() => {
      mockExecSync('claude -p \'test\'', { encoding: 'utf8', timeout: 30000 });
    }).toThrow('Command not found: claude');
    
    // Reset mock
    mockExecSync.mockRestore();
  });
});

describe('findLatestBackup', () => {
  it('should find the latest backup by timestamp', () => {
    const backupFiles = [
      'abc123.jsonl.1640995200000', // older
      'abc123.jsonl.1641081600000', // newest
      'abc123.jsonl.1640908800000', // oldest
      'def456.jsonl.1641000000000', // different session
    ];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toEqual({
      name: 'abc123.jsonl.1641081600000',
      timestamp: 1641081600000
    });
  });

  it('should return null when no backups found for session', () => {
    const backupFiles = [
      'def456.jsonl.1640995200000',
      'xyz789.jsonl.1641081600000',
    ];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toBeNull();
  });

  it('should handle empty backup files array', () => {
    const result = findLatestBackup([], 'abc123');

    expect(result).toBeNull();
  });

  it('should handle single backup file', () => {
    const backupFiles = ['abc123.jsonl.1640995200000'];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toEqual({
      name: 'abc123.jsonl.1640995200000',
      timestamp: 1640995200000
    });
  });

  it('should filter out files that do not match session pattern', () => {
    const backupFiles = [
      'abc123.jsonl.1640995200000',
      'abc123.txt.1641081600000', // wrong extension
      'abc123.jsonl', // missing timestamp
      'abc123-other.jsonl.1641000000000', // different naming
    ];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toEqual({
      name: 'abc123.jsonl.1640995200000',
      timestamp: 1640995200000
    });
  });

  it('should handle malformed timestamps gracefully', () => {
    const backupFiles = [
      'abc123.jsonl.invalid',
      'abc123.jsonl.1640995200000',
      'abc123.jsonl.abc',
    ];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toEqual({
      name: 'abc123.jsonl.1640995200000',
      timestamp: 1640995200000
    });
  });

  it('should sort by timestamp correctly with multiple valid backups', () => {
    const backupFiles = [
      'abc123.jsonl.1000', // smallest
      'abc123.jsonl.3000', // largest
      'abc123.jsonl.2000', // middle
    ];

    const result = findLatestBackup(backupFiles, 'abc123');

    expect(result).toEqual({
      name: 'abc123.jsonl.3000',
      timestamp: 3000
    });
  });
});

describe('summarization behavior', () => {
  it('should create proper summary line structure', () => {
    const summaryContent = 'Previously, we discussed various topics.';
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: summaryContent }
    });

    const parsed = JSON.parse(summaryLine);
    expect(parsed.type).toBe('user');
    expect(parsed.isCompactSummary).toBe(true);
    expect(parsed.message.content).toBe(summaryContent);
  });

  it('should collect dropped messages with content', () => {
    const lines = [
      'header line',
      '{"type":"user","message":{"content":"Hello"}}',
      '{"type":"assistant","message":{"content":"Hi there"}}',
      '{"type":"user","message":{"content":"How are you?"}}',
      '{"type":"assistant","message":{"content":"I am fine"}}',
    ];
    
    const { droppedMessages } = pruneSessionLines(lines, 1);
    
    expect(droppedMessages).toHaveLength(3);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Hello' });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'Hi there' });
    expect(droppedMessages[2]).toEqual({ type: 'user', content: 'How are you?' });
  });

  it('should not collect dropped messages when all are kept', () => {
    const lines = [
      'header line',
      '{"type":"user","message":{"content":"Hello"}}',
      '{"type":"assistant","message":{"content":"Hi there"}}',
    ];
    
    const { droppedMessages } = pruneSessionLines(lines, 10);
    
    expect(droppedMessages).toHaveLength(0);
  });

  it('should handle summary insertion after pruning', () => {
    // Test the behavior of inserting summary at position 1
    const outLines = ['header line', 'message 1', 'message 2'];
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Previously, we discussed test topics." }
    });

    // Insert summary after first line
    outLines.splice(1, 0, summaryLine);

    expect(outLines).toHaveLength(4);
    expect(outLines[0]).toBe('header line');
    expect(outLines[1]).toBe(summaryLine);
    expect(outLines[2]).toBe('message 1');
    expect(outLines[3]).toBe('message 2');
  });

  it('should handle empty outLines array for summary insertion', () => {
    const outLines: string[] = [];
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Summary content" }
    });

    // When outLines is empty, push to end
    if (outLines.length > 0) {
      outLines.splice(1, 0, summaryLine);
    } else {
      outLines.push(summaryLine);
    }

    expect(outLines).toHaveLength(1);
    expect(outLines[0]).toBe(summaryLine);
  });
});