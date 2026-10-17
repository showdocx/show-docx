export interface XmlTag {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly attributes: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

interface HiddenRunProperties {
  vanish?: boolean;
  specVanish?: boolean;
}

export interface HiddenStyleInfo {
  readonly byId: ReadonlyMap<string, boolean>;
  readonly defaultHidden?: boolean;
  /** vanish is a style-chain toggle parity; specVanish is an inherited absolute value. */
  readonly propertiesById?: ReadonlyMap<string, HiddenRunProperties>;
  readonly defaultProperties?: HiddenRunProperties;
  readonly defaultParagraphStyle?: string;
  readonly defaultCharacterStyle?: string;
}

interface StyleRecord extends HiddenRunProperties {
  basedOn?: string;
}

/** Resolves vanish toggles (ISO 29500 §17.7.3) separately from absolute specVanish. */
export function readHiddenStyleInfo(stylesXml: string): HiddenStyleInfo {
  const records = new Map<string, StyleRecord>();
  const defaults: HiddenRunProperties = {};
  const parents: string[] = [];
  let defaultParagraphStyle: string | undefined;
  let defaultCharacterStyle: string | undefined;
  let currentStyle: StyleRecord | undefined;

  for (const tag of scanCurrentXmlTags(stylesXml)) {
    if (tag.closing) {
      if (tag.name === 'w:style') {currentStyle = undefined;}
      parents.pop();
      continue;
    }
    const parent = parents[parents.length - 1];
    if (tag.name === 'w:style') {
      const id = xmlAttribute(tag.attributes, 'w:styleId');
      currentStyle = {};
      if (id) {
        records.set(id, currentStyle);
        const isDefault = xmlAttribute(tag.attributes, 'w:default');
        if (isDefault !== undefined && parseOnOff(isDefault)) {
          const type = xmlAttribute(tag.attributes, 'w:type');
          if (type === 'paragraph') {defaultParagraphStyle = id;}
          if (type === 'character') {defaultCharacterStyle = id;}
        }
      }
    } else if (tag.name === 'w:basedOn' && parent === 'w:style' && currentStyle) {
      currentStyle.basedOn = xmlAttribute(tag.attributes, 'w:val');
    } else if (parent === 'w:rPr' && (tag.name === 'w:vanish' || tag.name === 'w:specVanish')) {
      const owner = parents[parents.length - 2];
      const properties = owner === 'w:style' ? currentStyle : owner === 'w:rPrDefault' ? defaults : undefined;
      if (properties) {
        properties[tag.name === 'w:vanish' ? 'vanish' : 'specVanish'] = parseOnOff(xmlAttribute(tag.attributes, 'w:val'));
      }
    }
    if (!tag.selfClosing) {parents.push(tag.name);}
    else if (tag.name === 'w:style') {currentStyle = undefined;}
  }

  const vanish = resolveStyleProperty(records, 'vanish');
  const specVanish = resolveStyleProperty(records, 'specVanish');
  const byId = new Map<string, boolean>();
  const propertiesById = new Map<string, HiddenRunProperties>();
  for (const id of records.keys()) {
    const properties: HiddenRunProperties = {};
    if (vanish.get(id) !== undefined) {properties.vanish = vanish.get(id);}
    if (specVanish.get(id) !== undefined) {properties.specVanish = specVanish.get(id);}
    propertiesById.set(id, properties);
    if (properties.vanish !== undefined || properties.specVanish !== undefined) {
      byId.set(id, properties.vanish === true || properties.specVanish === true);
    }
  }
  return {
    byId,
    propertiesById,
    defaultProperties: defaults,
    defaultParagraphStyle,
    defaultCharacterStyle,
    defaultHidden: defaults.vanish === true || defaults.specVanish === true,
  };
}

function resolveStyleProperty(
  records: ReadonlyMap<string, StyleRecord>,
  property: keyof HiddenRunProperties,
): Map<string, boolean | undefined> {
  const cache = new Map<string, boolean | undefined>();
  for (const id of records.keys()) {
    const chain: string[] = [];
    const seen = new Map<string, number>();
    let current: string | undefined = id;
    let value: boolean | undefined;
    while (current !== undefined) {
      if (cache.has(current)) {
        value = cache.get(current);
        break;
      }
      const cycleStart = seen.get(current);
      if (cycleStart !== undefined) {
        // Invalid cyclic styles have no well-defined toggle order. Keep any
        // hidden declaration in the cycle instead of making visibility depend on lookup order.
        const cycle = chain.splice(cycleStart);
        for (const styleId of cycle) {
          const declared = records.get(styleId)?.[property];
          if (declared !== undefined) {value = value === true || declared;}
        }
        for (const styleId of cycle) {cache.set(styleId, value);}
        break;
      }
      const record = records.get(current);
      if (!record) {break;}
      seen.set(current, chain.length);
      chain.push(current);
      current = record.basedOn;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const styleId = chain[index];
      if (styleId === undefined) {continue;}
      const declared = records.get(styleId)?.[property];
      if (declared !== undefined) {
        value = property === 'vanish' ? (value ?? false) !== declared : declared;
      }
      cache.set(styleId, value);
    }
  }
  return cache;
}

/** Property-change children describe the previous formatting, never the current one. */
function* scanCurrentXmlTags(xml: string): Generator<XmlTag> {
  let historicalDepth = 0;
  for (const tag of scanXmlTags(xml)) {
    if (historicalDepth > 0) {
      if (tag.closing) {historicalDepth -= 1;}
      else if (!tag.selfClosing) {historicalDepth += 1;}
    } else if (!tag.closing && /^w:(?:\w*PrChange|tblGridChange|numberingChange)$/.test(tag.name)) {
      if (!tag.selfClosing) {historicalDepth = 1;}
    } else {
      yield tag;
    }
  }
}

/** Scans tags without regex backtracking over the contents of large XML parts. */
export function* scanXmlTags(xml: string): Generator<XmlTag> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) {return;}
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', start) || xml.startsWith('<!', start)) {
      const end = findTagEnd(xml, start + 2);
      cursor = end < 0 ? xml.length : end + 1;
      continue;
    }

    const end = findTagEnd(xml, start + 1);
    if (end < 0) {return;}
    const raw = xml.slice(start, end + 1);
    let offset = 1;
    let closing = false;
    if (raw[offset] === '/') {
      closing = true;
      offset += 1;
    }
    while (/\s/.test(raw[offset] ?? '')) {offset += 1;}
    const nameStart = offset;
    while (offset < raw.length && !/[\s/>]/.test(raw[offset] ?? '')) {offset += 1;}
    const name = raw.slice(nameStart, offset);
    if (name !== '') {
      const bodyEnd = raw.length - 1;
      let attributesEnd = bodyEnd;
      while (attributesEnd > offset && /\s/.test(raw[attributesEnd - 1] ?? '')) {attributesEnd -= 1;}
      const selfClosing = !closing && raw[attributesEnd - 1] === '/';
      if (selfClosing) {attributesEnd -= 1;}
      yield {
        start,
        end: end + 1,
        name,
        attributes: raw.slice(offset, attributesEnd),
        closing,
        selfClosing,
      };
    }
    cursor = end + 1;
  }
}

/** Extracts XML text in one pass, retaining Word paragraph and tab breaks. */
export function xmlTextContent(xml: string): string {
  const output: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) {
      output.push(xml.slice(cursor));
      break;
    }
    output.push(xml.slice(cursor, start));
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) {
        output.push(xml.slice(start + 9));
        break;
      }
      output.push(xml.slice(start + 9, end));
      cursor = end + 3;
      continue;
    }
    const end = findTagEnd(xml, start + 1);
    if (end < 0) {
      output.push(xml.slice(start));
      break;
    }
    if (!xml.startsWith('<?', start) && !xml.startsWith('<!', start)) {
      let nameStart = start + 1;
      let closing = false;
      if (xml[nameStart] === '/') {
        closing = true;
        nameStart += 1;
      }
      const nameEnd = findNameEnd(xml, nameStart, end);
      const name = xml.slice(nameStart, nameEnd);
      if (name === 'w:tab') {output.push('\t');}
      else if (name === 'w:br' || name === 'w:cr') {output.push('\n');}
      else if (closing && name === 'w:p') {output.push('\n');}
    }
    cursor = end + 1;
  }
  return output.join('');
}

function findNameEnd(xml: string, from: number, end: number): number {
  let cursor = from;
  while (cursor < end && !/[\s/>]/.test(xml[cursor] ?? '')) {cursor += 1;}
  return cursor;
}

function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let index = from; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote !== '') {
      if (character === quote) {quote = '';}
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/** Reads an XML attribute with literal whitespace normalization and one-pass entity decoding. */
export function xmlAttribute(attributes: string, name: string): string | undefined {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (/\s/.test(attributes[cursor] ?? '')) {cursor += 1;}
    const start = cursor;
    while (cursor < attributes.length && !/[\s=]/.test(attributes[cursor] ?? '')) {cursor += 1;}
    if (cursor === start) {
      cursor += 1;
      continue;
    }
    const attributeName = attributes.slice(start, cursor);
    while (/\s/.test(attributes[cursor] ?? '')) {cursor += 1;}
    if (attributes[cursor] !== '=') {continue;}
    cursor += 1;
    while (/\s/.test(attributes[cursor] ?? '')) {cursor += 1;}
    const quote = attributes[cursor];
    if (quote !== '"' && quote !== "'") {continue;}
    cursor += 1;
    const valueStart = cursor;
    while (cursor < attributes.length && attributes[cursor] !== quote) {cursor += 1;}
    if (attributeName === name) {return decodeXmlAttributeValue(attributes.slice(valueStart, cursor));}
    cursor += 1;
  }
  return undefined;
}

const PREDEFINED_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXmlAttributeValue(value: string): string {
  // XML normalizes CRLF as one line ending, then literal LF/CR/tab to spaces.
  // Do this before decoding: whitespace from character references stays distinct.
  const normalized = value.replace(/\r\n|[\t\n\r]/g, ' ');
  // One replacement pass is essential: &amp;#105; is the literal string &#105;,
  // not an alternate spelling of i. Never expand custom/DTD entities here.
  return normalized.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (entity: string, name: string) => {
    if (!name.startsWith('#')) {return PREDEFINED_XML_ENTITIES[name] ?? entity;}
    const hex = name.startsWith('#x');
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    const valid = code === 0x09 || code === 0x0a || code === 0x0d
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
    return valid ? String.fromCodePoint(code) : entity;
  });
}

/** Removes complete elements and their contents in one forward pass. */
export function removeXmlElements(xml: string, names: ReadonlySet<string>): string {
  let output = '';
  let keptFrom = 0;
  let depth = 0;
  for (const tag of scanXmlTags(xml)) {
    if (!names.has(tag.name)) {continue;}
    if (tag.closing) {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {keptFrom = tag.end;}
      }
    } else if (depth > 0) {
      if (!tag.selfClosing) {depth += 1;}
    } else if (tag.selfClosing) {
      output += xml.slice(keptFrom, tag.start);
      keptFrom = tag.end;
    } else {
      output += xml.slice(keptFrom, tag.start);
      keptFrom = tag.start;
      depth = 1;
    }
  }
  // Preserve malformed, unclosed content rather than losing all following text.
  return output + xml.slice(keptFrom);
}

/** Removes hidden runs using current direct formatting, styles and document defaults. */
export function removeHiddenRuns(xml: string, styles?: HiddenStyleInfo): string {
  interface Run extends HiddenRunProperties {
    start: number;
    end?: number;
    hidden?: boolean;
    characterStyle?: string;
    paragraphStyle?: string;
  }
  const runs: Run[] = [];
  // Opening order keeps ranges sorted, including overlapping nested runs, in O(n).
  const ranges: Run[] = [];
  const paragraphStyles: Array<string | undefined> = [];
  const parents: string[] = [];
  const styleProperties = (id: string | undefined): HiddenRunProperties | undefined => {
    if (id === undefined) {return undefined;}
    return styles?.propertiesById?.get(id) ?? { vanish: styles?.byId.get(id) };
  };
  for (const tag of scanCurrentXmlTags(xml)) {
    if (tag.closing) {
      if (tag.name === 'w:p') {paragraphStyles.pop();}
      if (tag.name === 'w:r') {
        const run = runs.pop();
        if (run) {
          const character = styleProperties(run.characterStyle ?? styles?.defaultCharacterStyle);
          const paragraph = styleProperties(run.paragraphStyle ?? styles?.defaultParagraphStyle);
          const defaults = styles?.defaultProperties ?? { vanish: styles?.defaultHidden };
          // Styles contribute toggles across both chains; only direct run
          // formatting sets an absolute value. A style's false does not unhide text.
          const paragraphVanish = (defaults.vanish ?? false) !== (paragraph?.vanish ?? false);
          const vanish = run.vanish ?? (paragraphVanish !== (character?.vanish ?? false));
          const specVanish = run.specVanish ?? character?.specVanish ?? paragraph?.specVanish ?? defaults.specVanish ?? false;
          run.hidden = vanish || specVanish;
          run.end = tag.end;
        }
      }
      parents.pop();
      continue;
    }
    const parent = parents[parents.length - 1];
    const owner = parents[parents.length - 2];
    if (tag.name === 'w:p' && !tag.selfClosing) {
      paragraphStyles.push(undefined);
    } else if (tag.name === 'w:pStyle' && parent === 'w:pPr' && owner === 'w:p') {
      if (paragraphStyles.length > 0) {
        paragraphStyles[paragraphStyles.length - 1] = xmlAttribute(tag.attributes, 'w:val');
      }
    } else if (tag.name === 'w:r' && !tag.selfClosing) {
      const run: Run = { start: tag.start, paragraphStyle: paragraphStyles[paragraphStyles.length - 1] };
      runs.push(run);
      ranges.push(run);
    } else if (parent === 'w:rPr' && owner === 'w:r') {
      const run = runs[runs.length - 1];
      if (run) {
        if (tag.name === 'w:rStyle') {run.characterStyle = xmlAttribute(tag.attributes, 'w:val');}
        else if (tag.name === 'w:vanish' || tag.name === 'w:specVanish') {
          run[tag.name === 'w:vanish' ? 'vanish' : 'specVanish'] = parseOnOff(xmlAttribute(tag.attributes, 'w:val'));
        }
      }
    }
    if (!tag.selfClosing) {parents.push(tag.name);}
  }
  const output: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (!range.hidden || range.end === undefined) {continue;}
    if (range.start >= cursor) {output.push(xml.slice(cursor, range.start));}
    cursor = Math.max(cursor, range.end);
  }
  output.push(xml.slice(cursor));
  return output.join('');
}

function parseOnOff(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}
