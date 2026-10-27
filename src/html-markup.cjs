const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
};

const INLINE_TITLE_TAGS = new Set([
  'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'small', 'big', 'mark',
  'font', 'sub', 'sup', 'abbr', 'bdi', 'bdo', 'cite', 'code', 'dfn', 'kbd', 'samp', 'var', 'wbr'
]);

const RCDATA_TAGS = new Set(['textarea', 'title']);

const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const MATHML_TEXT_INTEGRATION_TAGS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);

const FOREIGN_BREAKOUT_TAGS = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img',
  'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small',
  'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var'
]);

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const hexadecimal = code[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(number) && number >= 0 && number <= 0x10FFFF
        ? String.fromCodePoint(number)
        : entity;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? entity;
  });
}

function cleanText(value, preserveInline = false) {
  const source = String(value || '');
  const parts = [];
  let cursor = 0;
  for (const tag of scanHtmlTags(source)) {
    // Title styling does not create whitespace. Other text extraction keeps
    // tag boundaries so separate fragments cannot manufacture a date.
    parts.push(source.slice(cursor, tag.start), preserveInline && INLINE_TITLE_TAGS.has(tag.name) ? '' : ' ');
    cursor = tag.end;
  }
  parts.push(source.slice(cursor));
  return decodeHtmlEntities(parts.join(''))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readHtmlTagHead(source, start) {
  if (source[start] !== '<') return null;
  let index = start + 1;
  let closing = false;
  if (source[index] === '/') {
    closing = true;
    index += 1;
  }
  // HTML requires the tag name immediately after < or </; whitespace here
  // is literal text (or a bogus end-tag comment), not a tag boundary.
  if (!/[A-Za-z]/.test(source[index] || '')) return null;

  const nameStart = index;
  while (/[A-Za-z0-9:-]/.test(source[index] || '')) index += 1;
  return { name: source.slice(nameStart, index).toLowerCase(), closing, attributesStart: index };
}

// Scans attributes from the end of the tag name; returns the index of the closing > plus
// whether a slash immediately preceded it as a self-closing marker.
function findHtmlTagEnd(source, attributesStart) {
  let quote = null;
  let valueState = null;
  let slashAtBoundary = false;
  for (let index = attributesStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        valueState = null;
      }
      continue;
    }
    // A quote only opens a quoted value immediately after an attribute's =.
    // Quotes embedded in unquoted values remain literal HTML parse errors.
    if (valueState === 'before' && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (character === '>') {
      return { end: index + 1, selfClosingSlash: source[index - 1] === '/' && slashAtBoundary };
    }
    if (/\s/.test(character)) {
      if (valueState === 'unquoted') valueState = null;
      continue;
    }
    if (valueState === 'before') valueState = 'unquoted';
    else if (valueState === null && character === '=') valueState = 'before';
    // A slash after an attribute name is valid too. Only an unquoted value
    // consumes it as text; a self-closing slash must immediately precede >.
    if (character === '/') slashAtBoundary = valueState !== 'unquoted';
  }
  return null;
}

function readHtmlTag(source, start) {
  const head = readHtmlTagHead(source, start);
  if (!head) return null;
  const tagEnd = findHtmlTagEnd(source, head.attributesStart);
  if (!tagEnd) return null;
  return {
    name: head.name,
    closing: head.closing,
    attributesStart: head.attributesStart,
    selfClosing: !head.closing && tagEnd.selfClosingSlash,
    end: tagEnd.end
  };
}

function* scanHtmlTags(source) {
  let index = 0;
  while ((index = source.indexOf('<', index)) !== -1) {
    if (source.startsWith('<!--', index) || source.startsWith('<!', index) || source.startsWith('<?', index)) {
      const end = source.startsWith('<!--', index) ? findCommentEnd(source, index) : source.indexOf('>', index + 2) + 1;
      if (end > index) {
        yield { name: '#declaration', start: index, end };
        index = end;
        continue;
      }
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    yield { ...tag, start: index };
    index = tag.end;
  }
}

function findCommentEnd(source, start) {
  const closingIndex = source.indexOf('-->', start + 4);
  return closingIndex === -1 ? source.length : closingIndex + 3;
}

function findRawElementEnd(source, start, name) {
  // Markup-like strings in raw text and RCDATA are not opening tags.
  // Look only for a matching end tag, with a boundary after its exact name.
  const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  closingTag.lastIndex = start;
  const match = closingTag.exec(source);
  return match ? readHtmlTag(source, match.index)?.end || source.length : source.length;
}

function createMarkupContextTracker(source, templateRoot = false) {
  // Track namespace boundaries and their HTML descendants, so integration-point
  // exceptions apply only to immediate children, not nested HTML wrappers.
  const contexts = templateRoot ? [{ name: 'template', namespace: 'html', elementNamespace: 'html' }] : [];
  return (tag) => {
    let namespace = contexts.at(-1)?.namespace || 'html';
    if (tag.closing) {
      for (let index = contexts.length - 1; index >= 0; index -= 1) {
        if (contexts[index].name === tag.name) {
          namespace = contexts[index].elementNamespace;
          contexts.length = index;
          break;
        }
      }
      return namespace;
    }
    const breaksOut = FOREIGN_BREAKOUT_TAGS.has(tag.name) || tag.name === 'font' &&
      ['color', 'face', 'size'].some(name => readHtmlAttribute(source, tag, name) !== null);
    if (namespace !== 'html' && breaksOut) {
      while (contexts.length && contexts.at(-1).namespace !== 'html') contexts.pop();
      namespace = 'html';
    }
    const parent = contexts.at(-1);
    const mathTextException = namespace === 'html' && parent?.elementNamespace === 'math' &&
      MATHML_TEXT_INTEGRATION_TAGS.has(parent.name) && ['mglyph', 'malignmark'].includes(tag.name);
    if (mathTextException) namespace = 'math';
    if (namespace === 'html' && (tag.name === 'svg' || tag.name === 'math')) namespace = tag.name;
    if (namespace !== 'html' && tag.selfClosing) return namespace;
    const integrationPoint = namespace === 'svg' && ['foreignobject', 'desc', 'title'].includes(tag.name) ||
      namespace === 'math' && (MATHML_TEXT_INTEGRATION_TAGS.has(tag.name) ||
        tag.name === 'annotation-xml' && /^(?:text\/html|application\/xhtml\+xml)$/i.test(
          decodeHtmlEntities(readHtmlAttribute(source, tag, 'encoding') || '')
        ));
    const htmlDescendant = contexts.length > 0 && namespace === 'html' && !HTML_VOID_TAGS.has(tag.name);
    if (tag.name === 'svg' || tag.name === 'math' || tag.name === 'template' || integrationPoint || mathTextException || htmlDescendant) {
      contexts.push({ name: tag.name, namespace: integrationPoint ? 'html' : namespace, elementNamespace: namespace });
    }
    return namespace;
  };
}

function findTemplateEnd(source, start) {
  let depth = 1;
  let index = start;
  const trackContext = createMarkupContextTracker(source, true);
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      index = findCommentEnd(source, index);
      continue;
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    const namespace = trackContext(tag);
    if (namespace !== 'html' && tag.selfClosing) {
      index = tag.end;
      continue;
    }
    if (!tag.closing && (RCDATA_TAGS.has(tag.name) || tag.name === 'script' || tag.name === 'style')) {
      index = findRawElementEnd(source, tag.end, tag.name);
      trackContext({ ...tag, closing: true });
      continue;
    }
    if (tag.name === 'template' && namespace === 'html') {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return tag.end;
      } else {
        depth += 1;
      }
    }
    index = tag.end;
  }
  return source.length;
}

function maskRange(output, start, end) {
  for (let index = start; index < end; index += 1) {
    if (output[index] !== '\r' && output[index] !== '\n') output[index] = ' ';
  }
}

function maskNonVisibleRegions(content) {
  const source = String(content || '');
  const output = source.split('');
  let index = 0;
  const trackContext = createMarkupContextTracker(source);

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = findCommentEnd(source, index);
      maskRange(output, index, end);
      index = end;
      continue;
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    const namespace = trackContext(tag);
    if (namespace !== 'html' && tag.selfClosing) {
      index = tag.end;
      continue;
    }
    // Raw text and RCDATA cannot contribute notice markup or publication
    // metadata. HTML ignores trailing slashes on these non-void elements.
    if (!tag.closing && (RCDATA_TAGS.has(tag.name) || tag.name === 'script' || tag.name === 'style')) {
      const end = findRawElementEnd(source, tag.end, tag.name);
      maskRange(output, index, end);
      index = end;
      trackContext({ ...tag, closing: true });
      continue;
    }
    if (!tag.closing && tag.name === 'template' && namespace === 'html') {
      const end = findTemplateEnd(source, tag.end);
      maskRange(output, index, end);
      index = end;
      trackContext({ ...tag, closing: true });
      continue;
    }
    index = tag.end;
  }

  return output.join('');
}

function extractVisibleText(content) {
  return cleanText(maskNonVisibleRegions(content));
}

function findBalancedElements(scanDocument, type) {
  const openElements = [];
  const elements = [];
  const listStack = [];
  const finishElement = (end) => {
    const opening = openElements.pop();
    if (!opening) return;
    elements.push({ type, start: opening.start, end, content: scanDocument.slice(opening.start, end) });
  };

  for (const tag of scanHtmlTags(scanDocument)) {
    if (type === 'li' && ['ul', 'ol', 'menu'].includes(tag.name)) {
      if (!tag.closing) {
        listStack.push(tag.name);
      } else {
        const listIndex = listStack.lastIndexOf(tag.name);
        if (listIndex !== -1) {
          // The final li can end at its list boundary. Nested lists own their
          // items, so closing an inner list must leave the outer li open.
          while (openElements.length && openElements.at(-1).listDepth > listIndex) {
            finishElement(tag.start);
          }
          listStack.length = listIndex;
        }
      }
      continue;
    }
    if (tag.name !== type) continue;
    if (tag.closing) {
      if (type === 'li' && openElements.at(-1)?.listDepth !== listStack.length) continue;
      finishElement(tag.end);
    } else if (!tag.selfClosing || type === 'a' || type === 'span' || type === 'time') {
      // A sibling li implicitly ends the prior item in the same list.
      if (type === 'li' && listStack.length && openElements.at(-1)?.listDepth === listStack.length) {
        finishElement(tag.start);
      }
      // Preserve link/label matching: a trailing slash does not close these
      // non-void HTML elements before their actual end tag.
      openElements.push({ start: tag.start, listDepth: listStack.length });
    }
  }

  return elements;
}

function readHtmlAttribute(source, tag, name) {
  const attributes = source.slice(tag.attributesStart, tag.end - 1);
  // Consume whole attributes, including quoted values, before comparing names.
  // This keeps data-href and text such as title="href='...'" out of URL lookup.
  const pattern = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return null;
}

function extractAnchors(visibleContent) {
  const anchors = [];
  let opening = null;
  let index = 0;
  while ((index = visibleContent.indexOf('<', index)) !== -1) {
    const tag = readHtmlTag(visibleContent, index);
    if (!tag) {
      index += 1;
      continue;
    }
    if (tag.name === 'a') {
      if (tag.closing) {
        if (opening && opening.href !== null) {
          anchors.push({ href: opening.href, titleHtml: visibleContent.slice(opening.end, index) });
        }
        opening = null;
      } else {
        opening = { href: readHtmlAttribute(visibleContent, tag, 'href'), end: tag.end };
      }
    }
    index = tag.end;
  }
  return anchors;
}

module.exports = {
  ENTITY_MAP,
  INLINE_TITLE_TAGS,
  RCDATA_TAGS,
  HTML_VOID_TAGS,
  MATHML_TEXT_INTEGRATION_TAGS,
  FOREIGN_BREAKOUT_TAGS,
  decodeHtmlEntities,
  cleanText,
  readHtmlTagHead,
  findHtmlTagEnd,
  readHtmlTag,
  scanHtmlTags,
  findCommentEnd,
  findRawElementEnd,
  createMarkupContextTracker,
  findTemplateEnd,
  maskRange,
  maskNonVisibleRegions,
  extractVisibleText,
  findBalancedElements,
  readHtmlAttribute,
  extractAnchors
};
