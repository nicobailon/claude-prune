import { describe, it, expect } from 'vitest';
import { pruneSessionLines } from './index.js';

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

    const result = pruneSessionLines(lines, 0);
    
    expect(result.outLines).toHaveLength(1);
    expect(result.outLines[0]).toBe(lines[0]);
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

    const result = pruneSessionLines(lines, 2);
    
    expect(result.outLines).toHaveLength(4); // summary + 3 messages from assistant 2 onward
    expect(result.kept).toBe(3);
    expect(result.dropped).toBe(3);
    expect(result.assistantCount).toBe(3);
  });

  it('should keep all messages if assistant count <= keepN', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      createMessage("user", "3"),
      createMessage("assistant", "4"),
    ];

    const result = pruneSessionLines(lines, 5);
    
    expect(result.outLines).toHaveLength(5); // all lines
    expect(result.kept).toBe(4);
    expect(result.dropped).toBe(0);
    expect(result.assistantCount).toBe(2);
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

    const result = pruneSessionLines(lines, 1);
    
    expect(result.outLines).toHaveLength(6); // summary + tool result + non-json + 2 messages from assistant
    expect(result.kept).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.assistantCount).toBe(1);
  });

  it('should handle empty lines array', () => {
    const result = pruneSessionLines([], 5);
    
    expect(result.outLines).toHaveLength(0);
    expect(result.kept).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.assistantCount).toBe(0);
  });

  it('should handle no assistant messages', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("user", "2"),
      createMessage("system", "3"),
    ];

    const result = pruneSessionLines(lines, 2);
    
    expect(result.outLines).toHaveLength(4); // all lines since no assistant messages to cut from
    expect(result.kept).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.assistantCount).toBe(0);
  });

  it('should handle malformed JSON gracefully', () => {
    const lines = [
      createSummary("Session summary"),
      "invalid json",
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      "{ invalid json",
    ];

    const result = pruneSessionLines(lines, 1);
    
    expect(result.outLines).toHaveLength(5); // summary + invalid json + 2 messages + invalid json
    expect(result.kept).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.assistantCount).toBe(1);
  });

  it('should handle keepN = 0', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
      createMessage("user", "3"),
      createMessage("assistant", "4"),
    ];

    const result = pruneSessionLines(lines, 0);
    
    expect(result.outLines).toHaveLength(1); // only summary
    expect(result.kept).toBe(0);
    expect(result.dropped).toBe(4);
    expect(result.assistantCount).toBe(2);
  });

  it('should handle negative keepN', () => {
    const lines = [
      createSummary("Session summary"),
      createMessage("user", "1"),
      createMessage("assistant", "2"),
    ];

    const result = pruneSessionLines(lines, -5);
    
    expect(result.outLines).toHaveLength(1); // only summary
    expect(result.kept).toBe(0);
    expect(result.dropped).toBe(2);
    expect(result.assistantCount).toBe(1);
  });
});