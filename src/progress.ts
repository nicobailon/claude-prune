import cliProgress from 'cli-progress';
import chalk from 'chalk';

export interface ProgressOptions {
  transcriptKB: number;
  model?: string;
}

export function createSummaryProgress(options: ProgressOptions) {
  const { transcriptKB, model } = options;

  const isHaiku = model?.toLowerCase().includes('haiku') ?? false;
  const modelMultiplier = isHaiku ? 0.33 : 1;
  let estimatedSeconds = Math.max(30, Math.ceil(transcriptKB * 2 * modelMultiplier));

  const bar = new cliProgress.SingleBar({
    format: `Generating summary | ${chalk.cyan('{bar}')} | {percentage}% | {elapsed}s / ~{estimate}s`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    clearOnComplete: true,
    stream: process.stdout
  });

  let startTime = Date.now();

  return {
    start() {
      bar.start(100, 0, { elapsed: 0, estimate: estimatedSeconds });
      startTime = Date.now();
    },

    update() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      let percent = (elapsed / estimatedSeconds) * 100;

      if (percent >= 80 && percent < 95) {
        estimatedSeconds = Math.min(600, Math.ceil(estimatedSeconds * 1.25));
        percent = (elapsed / estimatedSeconds) * 100;
      }

      percent = Math.min(95, percent);

      bar.update(Math.floor(percent), {
        elapsed,
        estimate: estimatedSeconds
      });
    },

    succeed() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      bar.update(100, { elapsed, estimate: estimatedSeconds });
      bar.stop();
      console.log(chalk.green('\u2714') + ' Summary generated.');
    },

    fail(message: string) {
      bar.stop();
      console.log(chalk.red('\u2716') + ` ${message}`);
    }
  };
}
