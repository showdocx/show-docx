import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * What the extension host reads out of a document — its properties and its
 * structure — produced by the host's own parser, so the webview tests see what
 * a real document produces rather than a description written by hand.
 *
 * The parser is TypeScript, run from its compiled form in dist-test;
 * `npm run test:webview` compiles it first.
 */

const require = createRequire(import.meta.url);

function hostModule(name) {
  try {
    return require(`../../dist-test/src/text/${name}.js`);
  } catch (error) {
    throw new Error(
      'The webview tests read documents with the extension host\'s own parser, compiled into '
      + `dist-test. Run "npm run compile-tests" first. (${error.message})`,
    );
  }
}

/** Documents a test built and served in place of a fixture, by the name it serves them under. */
const served = new Map();

export function rememberServed(name, bytes) {
  served.set(name, bytes);
}

async function bytesOf(name) {
  return served.get(name)
    ?? new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url)));
}

/**
 * Answers the harness's request for a document's details, the way the host
 * posts them after reading the package.
 */
export async function routeHostDetails(page) {
  const { readDocumentProperties } = hostModule('documentFacts');
  const { readDocumentStructure } = hostModule('documentStructure');
  await page.route('**/__details/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/__details/')[1] ?? '');
    try {
      const bytes = await bytesOf(name);
      await route.fulfill({
        json: {
          properties: await readDocumentProperties(bytes),
          structure: await readDocumentStructure(bytes),
        },
      });
    } catch {
      // A document the host could not read sends no details at all.
      await route.fulfill({ status: 404, body: '' });
    }
  });
}
