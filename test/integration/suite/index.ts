import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Mocha from 'mocha';

export async function run(): Promise<void> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<{ default: typeof Mocha }>;
  const { default: MochaConstructor } = await dynamicImport('mocha');
  const mocha = new MochaConstructor({
    color: true,
    timeout: 20_000,
    ui: 'bdd',
  });
  // Tests tagged @restricted need an untrusted workspace, which only the
  // restricted run has; every other run leaves them out.
  // SHOWDOCX_TEST_GREP=pattern runs only the matching tests, as mocha's --grep would.
  const grep = process.env.SHOWDOCX_TEST_GREP;
  if (process.env.SHOWDOCX_RESTRICTED === '1') {
    mocha.grep('@restricted');
  } else if (grep) {
    mocha.grep(grep);
  } else {
    mocha.grep('@restricted').invert();
  }
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
