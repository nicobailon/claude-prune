import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import chalk from 'chalk';

vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

vi.mock('chalk', () => ({
  default: {
    yellow: vi.fn((msg: string) => msg)
  }
}));

import { generateSummary } from './index.js';

describe('generateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should generate summary from dropped messages', async () => {
    const mockSummary = 'Previously, we discussed testing and implementation details.';
    vi.mocked(execSync).mockReturnValue(mockSummary + '\n');

    const droppedMessages = [
      { type: 'user', content: 'How do I write tests?' },
      { type: 'assistant', content: 'Use vitest for testing.' }
    ];

    const result = await generateSummary(droppedMessages);

    expect(result).toBe(mockSummary);
    expect(execSync).toHaveBeenCalledWith(
      'claude -p',
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 60000,
        input: expect.stringContaining('How do I write tests?')
      })
    );
  });

  it('should format transcript correctly with proper labels', async () => {
    vi.mocked(execSync).mockReturnValue('Summary content\n');

    const droppedMessages = [
      { type: 'user', content: 'Question 1' },
      { type: 'assistant', content: 'Answer 1' },
      { type: 'system', content: 'System message' },
      { type: 'user', content: 'Question 2' }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('User: Question 1');
    expect(options.input).toContain('Assistant: Answer 1');
    expect(options.input).toContain('System: System message');
    expect(options.input).toContain('User: Question 2');
  });

  it('should truncate long transcripts', async () => {
    const longContent = 'A'.repeat(20000);
    const droppedMessages = [
      { type: 'user', content: longContent },
      { type: 'assistant', content: longContent },
      { type: 'user', content: longContent },
      { type: 'assistant', content: longContent }
    ];

    vi.mocked(execSync).mockReturnValue('Summary of truncated content\n');

    await generateSummary(droppedMessages, { maxLength: 60000 });

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('... (transcript truncated due to length)');
    expect(chalk.yellow).toHaveBeenCalledWith(expect.stringContaining('Transcript too long'));
  });

  it('should pass single quotes without escaping (using stdin)', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    const droppedMessages = [
      { type: 'user', content: "What's the user's name?" },
      { type: 'assistant', content: "The user's name is 'John'." }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain("What's the user's name?");
    expect(options.input).toContain("The user's name is 'John'.");
  });

  it('should include the correct prompt instructions', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    await generateSummary([{ type: 'user', content: 'test' }]);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('summarizing a coding conversation');
    expect(options.input).toContain('Previously, we discussed');
    expect(options.input).toContain('## 1. Overview');
    expect(options.input).toContain('## 2. What Was Accomplished');
    expect(options.input).toContain('## 3. Files Modified or Examined');
    expect(options.input).toContain('## 4. Key Technical Details');
    expect(options.input).toContain('## 5. Current State & Pending Work');
  });

  it('should handle empty messages array', async () => {
    vi.mocked(execSync).mockReturnValue('Empty summary\n');

    const result = await generateSummary([]);

    expect(result).toBe('Empty summary');
    expect(execSync).toHaveBeenCalled();
  });

  it('should trim whitespace from summary', async () => {
    vi.mocked(execSync).mockReturnValue('  Summary with spaces  \n\n');

    const result = await generateSummary([{ type: 'user', content: 'test' }]);

    expect(result).toBe('Summary with spaces');
  });

  it('should throw error with helpful message when CLI not found', async () => {
    const error = new Error('Command not found: claude');
    (error as any).code = 'ENOENT';
    vi.mocked(execSync).mockImplementation(() => {
      throw error;
    });

    await expect(generateSummary([{ type: 'user', content: 'test' }]))
      .rejects.toThrow('Claude CLI not found');
  });

  it('should throw error with helpful message on timeout', async () => {
    const error = new Error('Process timed out');
    (error as any).killed = true;
    vi.mocked(execSync).mockImplementation(() => {
      throw error;
    });

    await expect(generateSummary([{ type: 'user', content: 'test' }]))
      .rejects.toThrow('Summary generation timed out');
  });

  it('should respect custom maxLength option', async () => {
    const longContent = 'B'.repeat(5000);
    const droppedMessages = Array(5).fill(null).map(() => ({
      type: 'user',
      content: longContent
    }));

    vi.mocked(execSync).mockReturnValue('Summary\n');

    await generateSummary(droppedMessages, { maxLength: 10000 });

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('... (transcript truncated due to length)');
    expect(chalk.yellow).toHaveBeenCalledWith(expect.stringContaining('Truncating to 10000 chars'));
  });

  it('should pass model option to claude CLI', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    await generateSummary([{ type: 'user', content: 'test' }], { model: 'haiku' });

    expect(execSync).toHaveBeenCalledWith(
      'claude -p --model haiku',
      expect.any(Object)
    );
  });

  it('should not include model flag when model not specified', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    await generateSummary([{ type: 'user', content: 'test' }]);

    expect(execSync).toHaveBeenCalledWith(
      'claude -p',
      expect.any(Object)
    );
  });

  it('should return existing summary unchanged when only summary is dropped', async () => {
    const droppedMessages = [
      { type: 'user', content: 'Previously, we discussed the architecture.', isSummary: true }
    ];

    const result = await generateSummary(droppedMessages);

    expect(result).toBe('Previously, we discussed the architecture.');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('should use synthesis prompt when existing summary and chat messages', async () => {
    vi.mocked(execSync).mockReturnValue('Synthesized summary\n');

    const droppedMessages = [
      { type: 'user', content: 'Old summary content', isSummary: true },
      { type: 'user', content: 'New question' },
      { type: 'assistant', content: 'New answer' }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('## Existing Summary:');
    expect(options.input).toContain('Old summary content');
    expect(options.input).toContain('## Recent Conversation to Incorporate:');
    expect(options.input).toContain('New question');
    expect(options.input).toContain('New answer');
  });

  it('should exclude existing summary from chat transcript in synthesis mode', async () => {
    vi.mocked(execSync).mockReturnValue('Synthesized\n');

    const droppedMessages = [
      { type: 'user', content: 'This is the old summary', isSummary: true },
      { type: 'user', content: 'Regular chat message' }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    const chatSection = options.input.split('## Recent Conversation to Incorporate:')[1];
    expect(chatSection).not.toContain('This is the old summary');
    expect(chatSection).toContain('Regular chat message');
  });

  it('should handle messages without isSummary field (default to false)', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    const droppedMessages = [
      { type: 'user', content: 'Message without isSummary field' }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const options = call[1] as { input: string };

    expect(options.input).toContain('Message without isSummary field');
    expect(options.input).not.toContain('## Existing Summary:');
  });
});
