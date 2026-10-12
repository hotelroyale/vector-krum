#!/usr/bin/env node
// Interactive vectorization wizard.
//
//   vectorize-wizard <input.png|jpg> [output.svg]
import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { styleText } from 'node:util';
import { select } from '@inquirer/prompts';
import { vectorize } from './index.js';
import { Quality } from './presets.js';
import { Image, hasTransparency, premultiply } from './image.js';
import { classifyImage } from './classify.js';
import { loadImage, SUPPORTED_INPUT } from './io.js';
import {
  WizardAnswers,
  WizardContext,
  inquirerPrompter,
  runWizard,
  askDetail,
  summary,
  toVectorizeOptions,
  equivalentCommand,
  validateOutput,
  displayPath,
  STAGES,
  TYPE_NAMES,
  bold,
  dim,
} from './wizard.js';

const USAGE = `Usage: vectorize-wizard <input.png|jpg> [output.svg]

Interactively chooses the vectorization settings, then writes the SVG.
Prints the equivalent non-interactive 'vectorize' command at the end.
`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const positionals = argv.filter((a) => !a.startsWith('-'));
  if (positionals.length < 1 || positionals.length > 2 || positionals.length !== argv.length) {
    process.stderr.write(USAGE);
    return 1;
  }
  const inputPath = resolve(positionals[0]);
  const outputPath = positionals[1] === undefined ? undefined : resolve(positionals[1]);
  if (!existsSync(inputPath)) {
    process.stderr.write(`Input file not found: ${inputPath}\n`);
    return 1;
  }
  if (outputPath !== undefined && validateOutput(outputPath) !== true) {
    process.stderr.write(`${validateOutput(outputPath)}: ${outputPath}\n`);
    return 1;
  }
  let image: Image;
  try {
    image = loadImage(inputPath);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nSupported input: ${SUPPORTED_INPUT.join(', ')}\n`);
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('The wizard needs an interactive terminal. For scripts, use the `vectorize` command.\n');
    return 2;
  }

  const ctx: WizardContext = {
    inputPath,
    image,
    outputPath,
    classification: classifyImage(premultiply(image)),
    print: (s) => process.stdout.write(s + '\n'),
    color: process.stdout.hasColors?.(2 ** 24) === true && !process.env.NO_COLOR,
    written: new Set(),
  };
  ctx.print(`\n${bold('Vectorize')} ${basename(inputPath)} ${dim(`(${image.width}×${image.height}${hasTransparency(image) ? ', with transparency' : ''})`)}`);
  ctx.print(dim(`Detected: ${TYPE_NAMES[ctx.classification.type].toLowerCase()}\n`));

  let answers: WizardAnswers | undefined;
  for (;;) {
    answers = await runWizard(ctx, inquirerPrompter, answers);
    ctx.print(`\n${bold('Settings')}\n${summary(answers, ctx.color)}\n`);
    const next = await select<'run' | 'change' | 'cancel'>({
      message: 'Ready?',
      choices: [
        { value: 'run', name: 'Vectorize' },
        { value: 'change', name: 'Change settings' },
        { value: 'cancel', name: 'Cancel' },
      ],
    });
    if (next === 'cancel') return 130;
    if (next === 'change') continue;

    // Result page: the detail level can be changed and re-run directly.
    for (;;) {
      const t0 = Date.now();
      const result = vectorize(image, {
        ...toVectorizeOptions(answers),
        onProgress: (s) => process.stdout.write(dim(`  › ${STAGES[s] ?? s}…\n`)),
      });
      writeFileSync(answers.output, result.svg);
      ctx.written.add(answers.output);
      const curves = result.curves.reduce((n, c) => n + c.length, 0);
      const kb = (Buffer.byteLength(result.svg) / 1024).toFixed(1);
      ctx.print(
        `\n${styleText('green', '✔')} Wrote ${bold(displayPath(answers.output))}\n` +
          dim(`  ${result.segmentation.count} shapes, ${curves} curves, ${kb} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`) +
          dim(`  Same result without the wizard:\n`) +
          `  ${equivalentCommand(inputPath, answers)}\n`,
      );
      let detail: Quality = answers.quality;
      while (detail === answers.quality) {
        const next = await select<'done' | 'detail' | 'again'>({
          message: 'What next?',
          choices: [
            { value: 'done', name: 'Done' },
            { value: 'detail', name: 'Change detail level', description: 'Smoother or more detailed result; re-vectorizes with the other settings unchanged.' },
            { value: 'again', name: 'Try different settings' },
          ],
        });
        if (next === 'done') return 0;
        if (next === 'again') break;
        detail = await askDetail(answers.quality, inquirerPrompter);
      }
      if (detail === answers.quality) break;
      answers = { ...answers, quality: detail };
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    if (err?.name === 'ExitPromptError') {
      process.stdout.write('\nCancelled.\n');
      process.exit(130);
    }
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
