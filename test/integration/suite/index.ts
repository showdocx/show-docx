import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    timeout: 20_000,
    ui: 'bdd',
  });
  const testsDirectory = dirname(dirname(__filename));
  const testFiles = await findTests(testsDirectory);
  for (const file of testFiles) {
    mocha.addFile(file);
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

async function findTests(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTests(fullPath));
    } else if (entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}
