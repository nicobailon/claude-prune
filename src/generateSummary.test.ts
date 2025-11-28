import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import chalk from 'chalk';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('chalk', () => ({
  default: {
    yellow: vi.fn((msg: string) => msg),
    dim: vi.fn((msg: string) => msg)
  }
}));

import { generateSummary } from './index.js';

interface MockStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

interface MockChildProcess {
  child: ChildProcess;
  stdin: MockStdin;
  stdout: EventEmitter;
  stderr: EventEmitter;
  emit: (event: string, ...args: unknown[]) => boolean;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChildProcess(): MockChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as MockStdin;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  const child = new EventEmitter() as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: MockStdin }).stdin = stdin;
  (child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
  (child as unknown as { killed: boolean }).killed = false;
  return { child, stdin, stdout, stderr, emit: child.emit.bind(child), kill: (child as unknown as { kill: ReturnType<typeof vi.fn> }).kill };
}

describe('generateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should generate summary from dropped messages', async () => {
    const mockSummary = 'Previously, we discussed testing and implementation details.';
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: 'How do I write tests?' },
      { type: 'assistant', content: 'Use vitest for testing.' }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', mockSummary + '\n');
    mock.emit('close', 0);

    const result = await resultPromise;

    expect(result).toBe(mockSummary);
    expect(spawn).toHaveBeenCalledWith('claude', ['-p'], expect.any(Object));
    expect(mock.stdin.write).toHaveBeenCalledWith(expect.stringContaining('How do I write tests?'));
  });

  it('should format transcript correctly with proper labels', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: 'Question 1' },
      { type: 'assistant', content: 'Answer 1' },
      { type: 'system', content: 'System message' },
      { type: 'user', content: 'Question 2' }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Summary content\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain('User: Question 1');
    expect(writtenContent).toContain('Assistant: Answer 1');
    expect(writtenContent).toContain('System: System message');
    expect(writtenContent).toContain('User: Question 2');
  });

  it('should handle large transcripts under default limit without chunking', async () => {
    const longContent = 'A'.repeat(20000);
    const droppedMessages = [
      { type: 'user', content: longContent },
      { type: 'assistant', content: longContent }
    ];

    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Summary of content\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain('User: ' + longContent);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('should pass single quotes without escaping (using stdin)', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: "What's the user's name?" },
      { type: 'assistant', content: "The user's name is 'John'." }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain("What's the user's name?");
    expect(writtenContent).toContain("The user's name is 'John'.");
  });

  it('should include the correct prompt instructions', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }]);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain('summarizing a coding conversation');
    expect(writtenContent).toContain('Previously, we discussed');
    expect(writtenContent).toContain('## 1. Overview');
    expect(writtenContent).toContain('## 2. What Was Accomplished');
    expect(writtenContent).toContain('## 3. Files Modified or Examined');
    expect(writtenContent).toContain('## 4. Key Technical Details');
    expect(writtenContent).toContain('## 5. Current State & Pending Work');
  });

  it('should handle empty messages array', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([]);

    mock.stdout.emit('data', 'Empty summary\n');
    mock.emit('close', 0);

    const result = await resultPromise;

    expect(result).toBe('Empty summary');
    expect(spawn).toHaveBeenCalled();
  });

  it('should trim whitespace from summary', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }]);

    mock.stdout.emit('data', '  Summary with spaces  \n\n');
    mock.emit('close', 0);

    const result = await resultPromise;

    expect(result).toBe('Summary with spaces');
  });

  it('should throw error with helpful message when CLI not found', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }]);

    const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    mock.emit('error', error);

    await expect(resultPromise).rejects.toThrow('Claude CLI not found');
  });

  it('should throw error with helpful message on timeout', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }], { timeout: 1000 });

    vi.advanceTimersByTime(1000);
    mock.emit('close', null);

    await expect(resultPromise).rejects.toThrow('Summary generation timed out');
  });

  it('should handle multiple messages in single pass when under limit', async () => {
    const content = 'B'.repeat(5000);
    const droppedMessages = Array(5).fill(null).map(() => ({
      type: 'user',
      content: content
    }));

    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    const result = await resultPromise;

    expect(result).toBe('Summary');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('should use chunked summarization when maxLength exceeded', async () => {
    const longContent = 'C'.repeat(6000);
    const droppedMessages = Array(3).fill(null).map(() => ({
      type: 'user',
      content: longContent
    }));

    // Create mocks that will be returned in sequence
    const mocks = [
      createMockChildProcess(), // Chunk 1
      createMockChildProcess(), // Chunk 2
      createMockChildProcess()  // Combine
    ];
    let mockIndex = 0;
    vi.mocked(spawn).mockImplementation(() => {
      const mock = mocks[mockIndex];
      mockIndex++;
      // Schedule the mock responses
      setTimeout(() => {
        mock.stdout.emit('data', `Response ${mockIndex}\n`);
        mock.emit('close', 0);
      }, 10);
      return mock.child;
    });

    const resultPromise = generateSummary(droppedMessages, { maxLength: 10000 });

    // Advance timers to let all mocks respond
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result).toBe('Response 3');
    expect(spawn).toHaveBeenCalledTimes(3); // 2 chunks + 1 combine
    expect(chalk.yellow).toHaveBeenCalledWith(expect.stringContaining('Summarizing in chunks'));
  });

  it('should pass model option to claude CLI', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }], { model: 'haiku' });

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;

    expect(spawn).toHaveBeenCalledWith('claude', ['-p', '--model', 'haiku'], expect.any(Object));
  });

  it('should not include model flag when model not specified', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }]);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;

    expect(spawn).toHaveBeenCalledWith('claude', ['-p'], expect.any(Object));
  });

  it('should return existing summary unchanged when only summary is dropped', async () => {
    const droppedMessages = [
      { type: 'user', content: 'Previously, we discussed the architecture.', isSummary: true }
    ];

    const result = await generateSummary(droppedMessages);

    expect(result).toBe('Previously, we discussed the architecture.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('should use synthesis prompt when existing summary and chat messages', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: 'Old summary content', isSummary: true },
      { type: 'user', content: 'New question' },
      { type: 'assistant', content: 'New answer' }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Synthesized summary\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain('## Existing Summary:');
    expect(writtenContent).toContain('Old summary content');
    expect(writtenContent).toContain('## Recent Conversation to Incorporate:');
    expect(writtenContent).toContain('New question');
    expect(writtenContent).toContain('New answer');
  });

  it('should exclude existing summary from chat transcript in synthesis mode', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: 'This is the old summary', isSummary: true },
      { type: 'user', content: 'Regular chat message' }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Synthesized\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    const chatSection = writtenContent.split('## Recent Conversation to Incorporate:')[1];
    expect(chatSection).not.toContain('This is the old summary');
    expect(chatSection).toContain('Regular chat message');
  });

  it('should handle messages without isSummary field (default to false)', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const droppedMessages = [
      { type: 'user', content: 'Message without isSummary field' }
    ];

    const resultPromise = generateSummary(droppedMessages);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;

    const writtenContent = mock.stdin.write.mock.calls[0][0] as string;
    expect(writtenContent).toContain('Message without isSummary field');
    expect(writtenContent).not.toContain('## Existing Summary:');
  });

  it('should use default timeout of 360000ms', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary([{ type: 'user', content: 'test' }]);

    // Emit activity frequently to prevent activity timeout (90s)
    // Advance in small increments and emit data before activity timeout triggers
    for (let elapsed = 0; elapsed < 360000; elapsed += 5000) {
      mock.stdout.emit('data', '.'); // Keep activity alive
      vi.advanceTimersByTime(5000);
    }

    // At 360000ms, should have been killed by main timeout
    expect(mock.kill).toHaveBeenCalledWith('SIGTERM');

    mock.emit('close', null);
    await expect(resultPromise).rejects.toThrow('timed out after 360s');
  });

  it('should call onProgress callback periodically', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    let progressCallCount = 0;
    const resultPromise = generateSummary(
      [{ type: 'user', content: 'test' }],
      {
        onProgress: () => { progressCallCount++; }
      }
    );

    vi.advanceTimersByTime(1000);
    expect(progressCallCount).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(progressCallCount).toBe(2);

    mock.stdout.emit('data', 'Summary\n');
    mock.emit('close', 0);

    await resultPromise;
    expect(progressCallCount).toBeGreaterThanOrEqual(2);
  });

  it('should respect custom timeout option', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const resultPromise = generateSummary(
      [{ type: 'user', content: 'test' }],
      { timeout: 5000 }
    );

    vi.advanceTimersByTime(4999);
    expect(mock.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mock.kill).toHaveBeenCalledWith('SIGTERM');

    mock.emit('close', null);
    await expect(resultPromise).rejects.toThrow('timed out after 5s');
  });

  it('should include transcript size in timeout error message', async () => {
    const mock = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mock.child);

    const largeContent = 'X'.repeat(10000);
    const resultPromise = generateSummary(
      [{ type: 'user', content: largeContent }],
      { timeout: 1000 }
    );

    vi.advanceTimersByTime(1000);
    mock.emit('close', null);

    await expect(resultPromise).rejects.toThrow(/transcript:.*KB/);
  });
});
