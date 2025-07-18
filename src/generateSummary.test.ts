import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import chalk from 'chalk';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

// Mock chalk to avoid console output in tests
vi.mock('chalk', () => ({
  default: {
    yellow: vi.fn((msg: string) => msg)
  }
}));

// Import after mocks are set up
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
      expect.stringContaining('claude -p'),
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 30000
      })
    );
  });

  it('should format transcript correctly', async () => {
    vi.mocked(execSync).mockReturnValue('Summary content\n');

    const droppedMessages = [
      { type: 'user', content: 'Question 1' },
      { type: 'assistant', content: 'Answer 1' },
      { type: 'user', content: 'Question 2' }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const command = call[0] as string;
    
    expect(command).toContain('User: Question 1');
    expect(command).toContain('Assistant: Answer 1');
    expect(command).toContain('User: Question 2');
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
    const command = call[0] as string;
    
    expect(command).toContain('... (transcript truncated due to length)');
    expect(chalk.yellow).toHaveBeenCalledWith(expect.stringContaining('Transcript too long'));
  });

  it('should escape single quotes in content', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    const droppedMessages = [
      { type: 'user', content: "What's the user's name?" },
      { type: 'assistant', content: "The user's name is 'John'." }
    ];

    await generateSummary(droppedMessages);

    const call = vi.mocked(execSync).mock.calls[0];
    const command = call[0] as string;
    
    // Check that single quotes are properly escaped
    expect(command).toContain("What'\\''s the user'\\''s name?");
    expect(command).toContain("The user'\\''s name is '\\''John'\\''.");
  });

  it('should include the correct prompt instructions', async () => {
    vi.mocked(execSync).mockReturnValue('Summary\n');

    await generateSummary([{ type: 'user', content: 'test' }]);

    const call = vi.mocked(execSync).mock.calls[0];
    const command = call[0] as string;
    
    expect(command).toContain('provide a very concise, one-paragraph summary');
    expect(command).toContain('Start the summary with "Previously, we discussed..."');
    expect(command).toContain('The summary will be used as a memory');
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

  it('should throw error when execSync fails', async () => {
    const error = new Error('Command not found: claude');
    vi.mocked(execSync).mockImplementation(() => {
      throw error;
    });

    await expect(generateSummary([{ type: 'user', content: 'test' }]))
      .rejects.toThrow('Command not found: claude');
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
    const command = call[0] as string;
    
    expect(command).toContain('... (transcript truncated due to length)');
    expect(chalk.yellow).toHaveBeenCalledWith(expect.stringContaining('Truncating to 10000 chars'));
  });
});