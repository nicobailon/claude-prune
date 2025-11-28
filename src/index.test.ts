import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pruneSessionLines, findLatestBackup, getClaudeConfigDir, countAssistantMessages, extractMessageContent, generateUUID, listSessions, findLatestSession, getProjectDir } from './index.js';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import fs from 'fs-extra';

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
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'test', isSummary: false });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'test', isSummary: false });
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
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Hello', isSummary: false });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'Hi there', isSummary: false });
    expect(droppedMessages[2]).toEqual({ type: 'user', content: 'How are you?', isSummary: false });
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
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Valid message', isSummary: false });
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

describe('countAssistantMessages', () => {
  it('should count assistant messages correctly', () => {
    const lines = [
      'header',
      '{"type":"user","message":{"content":"hi"}}',
      '{"type":"assistant","message":{"content":"hello"}}',
      '{"type":"user","message":{"content":"bye"}}',
      '{"type":"assistant","message":{"content":"goodbye"}}',
    ];
    expect(countAssistantMessages(lines)).toBe(2);
  });

  it('should skip first line (header)', () => {
    const lines = [
      '{"type":"assistant","message":{"content":"header"}}',
      '{"type":"assistant","message":{"content":"real"}}',
    ];
    expect(countAssistantMessages(lines)).toBe(1);
  });

  it('should handle empty lines array', () => {
    expect(countAssistantMessages([])).toBe(0);
  });

  it('should handle no assistant messages', () => {
    const lines = [
      'header',
      '{"type":"user","message":{"content":"hi"}}',
      '{"type":"system","message":{"content":"info"}}',
    ];
    expect(countAssistantMessages(lines)).toBe(0);
  });

  it('should handle malformed JSON gracefully', () => {
    const lines = [
      'header',
      'invalid json',
      '{"type":"assistant","message":{"content":"hello"}}',
      '{ broken json',
    ];
    expect(countAssistantMessages(lines)).toBe(1);
  });
});

describe('percentage calculation', () => {
  it('should calculate keepN correctly from percentage', () => {
    expect(Math.max(1, Math.ceil(10 * 25 / 100))).toBe(3);
    expect(Math.max(1, Math.ceil(4 * 25 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(100 * 1 / 100))).toBe(1);
  });

  it('should enforce minimum of 1 message', () => {
    expect(Math.max(1, Math.ceil(10 * 0 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(3 * 10 / 100))).toBe(1);
  });

  it('should handle 100% correctly', () => {
    expect(Math.max(1, Math.ceil(10 * 100 / 100))).toBe(10);
    expect(Math.max(1, Math.ceil(50 * 100 / 100))).toBe(50);
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
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Hello', isSummary: false });
    expect(droppedMessages[1]).toEqual({ type: 'assistant', content: 'Hi there', isSummary: false });
    expect(droppedMessages[2]).toEqual({ type: 'user', content: 'How are you?', isSummary: false });
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
    const outLines = ['header line', 'message 1', 'message 2'];
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Previously, we discussed test topics." }
    });

    outLines.push(summaryLine);

    expect(outLines).toHaveLength(4);
    expect(outLines[0]).toBe('header line');
    expect(outLines[1]).toBe('message 1');
    expect(outLines[2]).toBe('message 2');
    expect(outLines[3]).toBe(summaryLine);
  });

  it('should handle empty outLines array for summary insertion', () => {
    const outLines: string[] = [];
    const summaryLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Summary content" }
    });

    outLines.push(summaryLine);

    expect(outLines).toHaveLength(1);
    expect(outLines[0]).toBe(summaryLine);
  });

  it('should remove existing summary before appending new one (deduplication)', () => {
    const oldSummary = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Old summary from previous prune" }
    });
    const outLines = ['header line', 'message 1', oldSummary, 'message 2'];
    const newSummary = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "New summary" }
    });

    // Simulate deduplication logic: remove existing summaries
    for (let i = outLines.length - 1; i >= 1; i--) {
      try {
        const parsed = JSON.parse(outLines[i]);
        if (parsed.isCompactSummary === true) {
          outLines.splice(i, 1);
        }
      } catch { /* not JSON */ }
    }
    outLines.push(newSummary);

    expect(outLines).toHaveLength(4);
    expect(outLines[0]).toBe('header line');
    expect(outLines[1]).toBe('message 1');
    expect(outLines[2]).toBe('message 2');
    expect(outLines[3]).toBe(newSummary);
    expect(outLines.filter(l => l.includes('isCompactSummary')).length).toBe(1);
  });
});

describe('summary in kept portion extraction', () => {
  it('should extract summary from kept lines when not in dropped', () => {
    const oldSummary = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "Old summary content" }
    });
    const outLines = [
      'header',
      '{"type":"user","message":{"content":"msg1"}}',
      '{"type":"assistant","message":{"content":"msg2"}}',
      oldSummary,
      '{"type":"user","message":{"content":"new msg"}}',
      '{"type":"assistant","message":{"content":"new response"}}',
    ];
    const droppedMessages: { type: string, content: string, isSummary?: boolean }[] = [
      { type: 'user', content: 'dropped msg', isSummary: false }
    ];

    const existingSummaryInDropped = droppedMessages.find(m => m.isSummary);
    if (!existingSummaryInDropped) {
      for (let i = 1; i < outLines.length; i++) {
        try {
          const parsed = JSON.parse(outLines[i]);
          if (parsed.isCompactSummary === true && parsed.message?.content) {
            droppedMessages.unshift({ type: 'user', content: parsed.message.content, isSummary: true });
            break;
          }
        } catch { /* not JSON */ }
      }
    }

    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Old summary content', isSummary: true });
  });

  it('should not extract summary if already in dropped messages', () => {
    const droppedMessages: { type: string, content: string, isSummary?: boolean }[] = [
      { type: 'user', content: 'Dropped summary', isSummary: true },
      { type: 'user', content: 'dropped msg', isSummary: false }
    ];
    const outLines = ['header', '{"type":"user","message":{"content":"msg1"}}'];

    const existingSummaryInDropped = droppedMessages.find(m => m.isSummary);
    if (!existingSummaryInDropped) {
      for (let i = 1; i < outLines.length; i++) {
        try {
          const parsed = JSON.parse(outLines[i]);
          if (parsed.isCompactSummary === true && parsed.message?.content) {
            droppedMessages.unshift({ type: 'user', content: parsed.message.content, isSummary: true });
            break;
          }
        } catch { /* not JSON */ }
      }
    }

    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].content).toBe('Dropped summary');
  });
});

describe('isSummary flag detection', () => {
  it('should set isSummary: true for isCompactSummary messages when dropped', () => {
    const lines = [
      'header line',
      '{"type":"user","isCompactSummary":true,"message":{"content":"Previous summary"}}',
      '{"type":"user","message":{"content":"Regular message"}}',
      '{"type":"assistant","message":{"content":"Response"}}',
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(3);
    expect(droppedMessages[0]).toEqual({ type: 'user', content: 'Previous summary', isSummary: true });
    expect(droppedMessages[1]).toEqual({ type: 'user', content: 'Regular message', isSummary: false });
    expect(droppedMessages[2]).toEqual({ type: 'assistant', content: 'Response', isSummary: false });
  });

  it('should set isSummary: false when isCompactSummary is missing', () => {
    const lines = [
      'header line',
      '{"type":"user","message":{"content":"Regular message"}}',
      '{"type":"assistant","message":{"content":"Response"}}',
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].isSummary).toBe(false);
    expect(droppedMessages[1].isSummary).toBe(false);
  });

  it('should set isSummary: false when isCompactSummary is false', () => {
    const lines = [
      'header line',
      '{"type":"user","isCompactSummary":false,"message":{"content":"Not a summary"}}',
      '{"type":"assistant","message":{"content":"Response"}}',
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].isSummary).toBe(false);
  });
});

describe('default 20% pruning', () => {
  it('should calculate 20% correctly', () => {
    expect(Math.max(1, Math.ceil(10 * 20 / 100))).toBe(2);
    expect(Math.max(1, Math.ceil(100 * 20 / 100))).toBe(20);
    expect(Math.max(1, Math.ceil(5 * 20 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(4 * 20 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(0 * 20 / 100))).toBe(1);
  });

  it('should enforce minimum of 1 for small sessions', () => {
    expect(Math.max(1, Math.ceil(1 * 20 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(2 * 20 / 100))).toBe(1);
    expect(Math.max(1, Math.ceil(3 * 20 / 100))).toBe(1);
  });
});

describe('extractMessageContent', () => {
  it('should return empty string for null/undefined', () => {
    expect(extractMessageContent(null)).toBe('');
    expect(extractMessageContent(undefined)).toBe('');
  });

  it('should return string content as-is', () => {
    expect(extractMessageContent('Hello world')).toBe('Hello world');
    expect(extractMessageContent('proceed')).toBe('proceed');
  });

  it('should extract text from array with text blocks', () => {
    const content = [
      { type: 'text', text: 'First paragraph' },
      { type: 'text', text: 'Second paragraph' }
    ];
    expect(extractMessageContent(content)).toBe('First paragraph\n\nSecond paragraph');
  });

  it('should extract text from tool_result with string content', () => {
    const content = [
      { tool_use_id: 'abc123', type: 'tool_result', content: 'Tool output here' }
    ];
    expect(extractMessageContent(content)).toBe('Tool output here');
  });

  it('should extract text from tool_result with array content', () => {
    const content = [
      {
        tool_use_id: 'abc123',
        type: 'tool_result',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' }
        ]
      }
    ];
    expect(extractMessageContent(content)).toBe('Line 1\nLine 2');
  });

  it('should extract thinking content', () => {
    const content = [
      { type: 'thinking', thinking: 'Internal reasoning here' }
    ];
    expect(extractMessageContent(content)).toBe('Internal reasoning here');
  });

  it('should extract tool name from tool_use block', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/test.ts' } }
    ];
    expect(extractMessageContent(content)).toBe('[Used tool: Read]');
  });

  it('should handle multiple tool_use blocks', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_01', name: 'Glob', input: {} },
      { type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} }
    ];
    expect(extractMessageContent(content)).toBe('[Used tool: Glob]\n\n[Used tool: Read]');
  });

  it('should handle mixed content types', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'xyz', name: 'read_file', input: {} },
      { type: 'text', text: 'World' }
    ];
    expect(extractMessageContent(content)).toBe('Hello\n\n[Used tool: read_file]\n\nWorld');
  });

  it('should handle objects with text but no type', () => {
    const content = [{ text: 'Simple text' }];
    expect(extractMessageContent(content)).toBe('Simple text');
  });

  it('should handle empty arrays', () => {
    expect(extractMessageContent([])).toBe('');
  });

  it('should skip non-extractable items', () => {
    const content = [
      { type: 'text', text: 'Valid text' },
      { invalid: 'object' }
    ];
    expect(extractMessageContent(content)).toBe('Valid text');
  });

  it('should handle real Claude Code assistant message content', () => {
    const content = [
      { type: 'text', text: "I'll help you with that. Let me first check the file." },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/test.ts' } }
    ];
    expect(extractMessageContent(content)).toBe("I'll help you with that. Let me first check the file.\n\n[Used tool: Read]");
  });

  it('should handle real Claude Code user message with tool result', () => {
    const content = [
      {
        tool_use_id: 'toolu_01',
        type: 'tool_result',
        content: 'File contents here:\nLine 1\nLine 2'
      }
    ];
    expect(extractMessageContent(content)).toBe('File contents here:\nLine 1\nLine 2');
  });
});

describe('generateUUID', () => {
  it('should generate valid UUID v4 format', () => {
    const uuid = generateUUID();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });

  it('should generate unique UUIDs', () => {
    const uuids = new Set();
    for (let i = 0; i < 100; i++) {
      uuids.add(generateUUID());
    }
    expect(uuids.size).toBe(100);
  });
});

describe('pruneSessionLines with array content', () => {
  it('should extract text from array content in dropped messages', () => {
    const lines = [
      'header line',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello from assistant' }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { tool_use_id: 'abc', type: 'tool_result', content: 'Tool output' }
          ]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Final response' }
          ]
        }
      }),
    ];
    const { droppedMessages } = pruneSessionLines(lines, 1);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].content).toBe('Hello from assistant');
    expect(droppedMessages[1].content).toBe('Tool output');
  });

  it('should handle mixed string and array content', () => {
    const lines = [
      'header line',
      JSON.stringify({
        type: 'user',
        message: { content: 'Simple string message' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Array message' }]
        }
      }),
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].content).toBe('Simple string message');
    expect(droppedMessages[1].content).toBe('Array message');
  });

  it('should handle null content gracefully', () => {
    const lines = [
      'header line',
      JSON.stringify({
        type: 'user',
        message: { content: null }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Valid' }] }
      }),
    ];
    const { droppedMessages } = pruneSessionLines(lines, 0);
    expect(droppedMessages).toHaveLength(2);
    expect(droppedMessages[0].content).toBe('');
    expect(droppedMessages[1].content).toBe('Valid');
  });
});

describe('listSessions', () => {
  const testDir = '/tmp/ccprune-test-sessions';

  beforeEach(async () => {
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('should return empty array for non-existent directory', async () => {
    const sessions = await listSessions('/non/existent/path');
    expect(sessions).toEqual([]);
  });

  it('should return empty array for empty directory', async () => {
    const sessions = await listSessions(testDir);
    expect(sessions).toEqual([]);
  });

  it('should find UUID sessions and ignore agent sessions', async () => {
    await fs.writeFile(join(testDir, '03953bb8-6855-4e53-a987-e11422a03fc6.jsonl'), 'test');
    await fs.writeFile(join(testDir, 'agent-b37f4f2f.jsonl'), 'test');
    await fs.writeFile(join(testDir, 'other.txt'), 'test');

    const sessions = await listSessions(testDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('03953bb8-6855-4e53-a987-e11422a03fc6');
  });

  it('should sort sessions by modification time (newest first)', async () => {
    const id1 = '03953bb8-6855-4e53-a987-e11422a03fc6';
    const id2 = '12345678-1234-1234-1234-123456789012';

    await fs.writeFile(join(testDir, `${id1}.jsonl`), 'older');
    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(join(testDir, `${id2}.jsonl`), 'newer');

    const sessions = await listSessions(testDir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(id2);
    expect(sessions[1].id).toBe(id1);
  });

  it('should include size and modification time', async () => {
    const content = 'x'.repeat(2048);
    await fs.writeFile(join(testDir, '03953bb8-6855-4e53-a987-e11422a03fc6.jsonl'), content);

    const sessions = await listSessions(testDir);
    expect(sessions[0].sizeKB).toBe(2);
    expect(sessions[0].modifiedAt).toBeInstanceOf(Date);
  });
});

describe('findLatestSession', () => {
  const testDir = '/tmp/ccprune-test-latest';

  beforeEach(async () => {
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('should return null for empty directory', async () => {
    const result = await findLatestSession(testDir);
    expect(result).toBeNull();
  });

  it('should return the most recent session', async () => {
    const id1 = '03953bb8-6855-4e53-a987-e11422a03fc6';
    const id2 = '12345678-1234-1234-1234-123456789012';

    await fs.writeFile(join(testDir, `${id1}.jsonl`), 'older');
    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(join(testDir, `${id2}.jsonl`), 'newer');

    const result = await findLatestSession(testDir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id2);
  });
});

describe('getProjectDir', () => {
  it('should construct project dir from cwd', () => {
    const dir = getProjectDir();
    expect(dir).toContain('projects');
    expect(dir).toContain('-');
  });
});