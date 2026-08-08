import { GFM, parser as markdownParser } from '@lezer/markdown';
import { findMinerUAlgorithmGroups } from '../markdown/markdown-algorithms.js';
import {
    findAcademicFigures,
    findAcademicTableGroups,
} from '../markdown/markdown-figures.js';
import {
    TRANSLATION_SEGMENTATION_VERSION,
} from './translation-profile.js';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from '../markdown/markdown-html.js';

const TRANSLATION_PARSER = markdownParser.configure(GFM);
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;
const SKIPPED_SUBTREES = new Set([
    'CodeBlock',
    'FencedCode',
    'HTMLBlock',
    'LinkReference',
    'Table',
]);
const REFERENCE_HEADING_PATTERN = /^(?:references?|references?[ \t]+and[ \t]+notes|reference[ \t]+list|bibliograph(?:y|ies)|literature[ \t]+cited|works[ \t]+cited|参考文献(?:[（(][ \t]*references?[ \t]*[）)])?|参考资料|参考书目|引用文献)$/iu;
const HTML_VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
]);
const PLACEHOLDER_PATTERN = /⟦MKTERO_(\d+)⟧/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>{}\[\]"']+/giu;
const NUMERIC_CITATION_PATTERN = /\[(?:\s*\d+[a-z]?(?:\s*[-–,;]\s*\d+[a-z]?)*\s*)\]/giu;
const AUTHOR_YEAR_CITATION_PATTERN = /\([^()\r\n]{0,180}\b(?:19|20)\d{2}[a-z]?[^()\r\n]{0,80}\)/giu;
const PANDOC_CITATION_PATTERN = /\[(?:[^\]\r\n]{0,200})@[A-Za-z0-9_:.+-]+(?:[^\]\r\n]{0,200})\]/gu;

export { TRANSLATION_SEGMENTATION_VERSION };

export function extractAcademicTranslationSegments(markdown) {
    const source = String(markdown || '');
    if (!source) return [];
    const figures = findAcademicFigures(source);
    const tables = findAcademicTableGroups(source);
    const captionedFigures = figures.filter(figure => (
        String(figure?.caption?.text || '').trim()
    ));
    const algorithmRanges = findMinerUAlgorithmGroups(source);
    const excludedRanges = [
        ...algorithmRanges,
        ...captionedFigures,
        ...tables,
    ];
    const displayMathRanges = findDisplayMathMatches(source).map(match => ({
        from: match.start,
        to: match.end,
    }));
    const segments = [];
    const headingPath = [];
    let referenceLevel = null;
    const appendedFigures = new Set();
    const resolvedFigures = new Set();
    const appendedTables = new Set();

    TRANSLATION_PARSER.parse(source).iterate({
        enter(node) {
            if (SKIPPED_SUBTREES.has(node.name)) return false;
            const headingMatch = HEADING_NODE.exec(node.name);
            if (headingMatch) {
                const level = Number(headingMatch[1]);
                const headingText = cleanHeadingSource(
                    source.slice(node.from, node.to),
                    node.name
                );
                const safeHeadingText = privacySafeSegmentSource(
                    headingText
                ).trim();
                if (referenceLevel !== null && level <= referenceLevel) {
                    referenceLevel = null;
                }
                headingPath.length = level - 1;
                if (isReferenceHeading(htmlTextForReferenceDetection(
                    headingText
                ))) {
                    referenceLevel = level;
                    headingPath[level - 1] = safeHeadingText;
                    return false;
                }
                headingPath[level - 1] = safeHeadingText;
                if (referenceLevel !== null) return false;
                const table = overlappingRange(tables, node);
                if (table) {
                    ensureTableCaptionSegment({
                        table,
                        headingPath,
                        segments,
                        appendedTables,
                        algorithmRanges,
                    });
                    return false;
                }
                appendSegment({
                    source,
                    node,
                    kind: 'heading',
                    headingPath,
                    excludedRanges,
                    displayMathRanges,
                    segments,
                });
                return false;
            }
            if (node.name === 'Paragraph') {
                if (referenceLevel === null
                    && isStandaloneReferenceParagraph(node)
                    && isReferenceHeading(htmlTextForReferenceDetection(
                        source.slice(node.from, node.to)
                    ))) {
                    referenceLevel = 7;
                    return false;
                }
                if (referenceLevel !== null) return false;
                const table = overlappingRange(tables, node);
                if (table) {
                    ensureTableCaptionSegment({
                        table,
                        headingPath,
                        segments,
                        appendedTables,
                        algorithmRanges,
                    });
                    return false;
                }
                const figure = overlappingRange(figures, node);
                if (figure) {
                    if (!appendedFigures.has(figure)) {
                        appendedFigures.add(figure);
                        if (overlapsAny(figure, algorithmRanges)) {
                            resolvedFigures.add(figure);
                            return false;
                        }
                        const result = appendFigureCaptionSegment({
                            figure,
                            headingPath,
                            segments,
                        });
                        if (result === 'appended' || result === 'skipped') {
                            resolvedFigures.add(figure);
                            return false;
                        }
                    }
                    if (resolvedFigures.has(figure)) {
                        return false;
                    }
                    appendSegment({
                        source,
                        node,
                        kind: paragraphKind(node),
                        headingPath,
                        excludedRanges,
                        displayMathRanges,
                        segments,
                    });
                    return false;
                }
                appendSegment({
                    source,
                    node,
                    kind: paragraphKind(node),
                    headingPath,
                    excludedRanges,
                    displayMathRanges,
                    segments,
                });
                return false;
            }
            return undefined;
        },
    });
    return segments.map((segment, index) => ({
        ...segment,
        id: `segment-${String(index + 1).padStart(6, '0')}`,
        sourceHash: segmentSourceHash(segment.source),
    }));
}

export function protectAcademicTranslationText(source, {
    displayMathRanges = [],
    sourceOffset = 0,
} = {}) {
    const value = String(source || '');
    const removals = [
        ...displayMathRanges
            .map(range => ({
                from: Math.max(0, range.from - sourceOffset),
                to: Math.min(value.length, range.to - sourceOffset),
                remove: true,
            }))
            .filter(range => range.from < range.to),
        ...findRawHtmlRemovalRanges(value),
    ];
    const protectedRanges = [];
    TRANSLATION_PARSER.parse(value).iterate({
        enter(node) {
            if (node.name === 'InlineCode' || node.name === 'URL') {
                protectedRanges.push({ from: node.from, to: node.to });
                return false;
            }
            return undefined;
        },
    });
    for (const match of findInlineMathMatches(value)) {
        protectedRanges.push({ from: match.start, to: match.end });
    }
    appendPatternRanges(protectedRanges, value, URL_PATTERN);
    appendPatternRanges(protectedRanges, value, NUMERIC_CITATION_PATTERN);
    appendPatternRanges(protectedRanges, value, AUTHOR_YEAR_CITATION_PATTERN);
    appendPatternRanges(protectedRanges, value, PANDOC_CITATION_PATTERN);

    const placeholders = [];
    const replacements = mergeProtectedRanges([
        ...removals,
        ...protectedRanges,
    ]).map(range => {
        if (range.remove) return { ...range, replacement: ' ' };
        const token = `⟦MKTERO_${placeholders.length}⟧`;
        placeholders.push({ token, value: value.slice(range.from, range.to) });
        return { ...range, replacement: token };
    });
    let prepared = applyReplacements(value, replacements);
    prepared = cleanMarkdownForTranslation(prepared);
    return { text: prepared, placeholders };
}

export function restoreAcademicTranslationPlaceholders(text, placeholders) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    let output = String(text || '').trim();
    const expected = new Set(placeholders.map(placeholder => placeholder.token));
    const seen = new Map();
    for (const match of output.matchAll(PLACEHOLDER_PATTERN)) {
        seen.set(match[0], (seen.get(match[0]) || 0) + 1);
        if (!expected.has(match[0])) {
            throw invalidPlaceholderError();
        }
    }
    for (const placeholder of placeholders) {
        if (seen.get(placeholder.token) !== 1) {
            throw invalidPlaceholderError();
        }
        output = output.replace(
            placeholder.token,
            () => placeholder.value
        );
    }
    const hasUnexpectedPlaceholder = PLACEHOLDER_PATTERN.test(output);
    PLACEHOLDER_PATTERN.lastIndex = 0;
    if (hasUnexpectedPlaceholder) throw invalidPlaceholderError();
    return output;
}

export function splitTranslationSegment(segment, maximumCharacters) {
    const limit = Math.max(1, Math.trunc(Number(maximumCharacters) || 0));
    const text = String(segment?.preparedText || '');
    if (text.length <= limit) {
        return [{
            id: segment.id,
            segmentID: segment.id,
            partIndex: 0,
            partCount: 1,
            kind: segment.kind,
            headingPath: segment.headingPath,
            source: text,
        }];
    }
    const parts = splitAtSafeBoundaries(text, limit);
    return parts.map((part, index) => ({
        id: `${segment.id}::${index + 1}`,
        segmentID: segment.id,
        partIndex: index,
        partCount: parts.length,
        kind: segment.kind,
        headingPath: segment.headingPath,
        source: part,
    }));
}

function appendSegment({
    source,
    node,
    kind,
    headingPath,
    excludedRanges,
    displayMathRanges,
    segments,
}) {
    if (overlapsAny(node, excludedRanges)) return;
    const raw = source.slice(node.from, node.to);
    const protectedText = protectAcademicTranslationText(raw, {
        displayMathRanges: displayMathRanges.filter(range => (
            range.from < node.to && range.to > node.from
        )),
        sourceOffset: node.from,
    });
    if (!hasEnglishTranslationCandidate(protectedText.text)) return;
    segments.push({
        from: node.from,
        to: node.to,
        anchor: node.to,
        kind,
        headingPath: headingPath.filter(Boolean).slice(),
        source: privacySafeSegmentSource(raw),
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
}

function appendFigureCaptionSegment({ figure, headingPath, segments }) {
    const raw = String(figure?.caption?.text || '').trim();
    if (!raw) return 'empty';
    const protectedText = protectAcademicTranslationText(raw);
    if (!hasEnglishTranslationCandidate(protectedText.text)) return 'skipped';
    segments.push({
        from: figure.from,
        to: figure.to,
        anchor: figure.to,
        kind: 'figure-caption',
        headingPath: headingPath.filter(Boolean).slice(),
        source: privacySafeSegmentSource(raw),
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
    return 'appended';
}

function ensureTableCaptionSegment({
    table,
    headingPath,
    segments,
    appendedTables,
    algorithmRanges = [],
}) {
    if (appendedTables.has(table)) return;
    appendedTables.add(table);
    if (overlapsAny(table, algorithmRanges)) return;
    appendTableCaptionSegment({ table, headingPath, segments });
}

function appendTableCaptionSegment({ table, headingPath, segments }) {
    const raw = String(table?.caption?.text || '').trim();
    if (!raw) return;
    const protectedText = protectAcademicTranslationText(raw);
    if (!hasEnglishTranslationCandidate(protectedText.text)) return;
    segments.push({
        from: table.from,
        to: table.to,
        anchor: table.to,
        kind: 'table-caption',
        headingPath: headingPath.filter(Boolean).slice(),
        source: privacySafeSegmentSource(raw),
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
}

function privacySafeSegmentSource(value) {
    const source = String(value || '');
    const htmlRanges = findRawHtmlRemovalRanges(source);
    if (!htmlRanges.length) return stripResidualHtmlTags(source);
    return stripResidualHtmlTags(applyReplacements(
        source,
        mergeProtectedRanges(htmlRanges).map(range => ({
            ...range,
            replacement: ' ',
        }))
    ));
}

function overlappingRange(ranges, node) {
    return ranges.find(candidate => (
        node.from < candidate.to && node.to > candidate.from
    ));
}

function paragraphKind(node) {
    for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === 'Blockquote') return 'blockquote';
        if (parent.name === 'ListItem') return 'list-item';
    }
    return 'paragraph';
}

function cleanHeadingSource(value, nodeName) {
    const source = String(value || '');
    if (nodeName.startsWith('ATXHeading')) {
        return source
            .replace(/^ {0,3}#{1,6}[\t ]+/u, '')
            .replace(/[\t ]+#+[\t ]*$/u, '')
            .trim();
    }
    return source.replace(/\r?\n {0,3}(?:=+|-+)[\t ]*$/u, '').trim();
}

function isReferenceHeading(value) {
    let normalized = String(value || '')
        .replace(/^ {0,3}#{1,6}[\t ]+/u, '')
        .replace(/[\t ]+#+[\t ]*$/u, '')
        .trim();
    for (let pass = 0; pass < 2; pass++) {
        normalized = normalized
            .replace(/[\t ]*[:：][\t ]*$/u, '')
            .replace(/^(?:\*{1,2}|_{1,2})+/u, '')
            .replace(/(?:\*{1,2}|_{1,2})+$/u, '')
            .replace(/^\d+(?:\.\d+)*[.)]?[\t ]+/u, '')
            .trim();
    }
    normalized = normalized.replace(/[\t ]+/gu, ' ');
    return REFERENCE_HEADING_PATTERN.test(normalized);
}

function htmlTextForReferenceDetection(value) {
    const source = String(value || '');
    const output = [];
    const openings = [];
    for (let offset = 0; offset < source.length; offset++) {
        let token = null;
        if (source[offset] === '<') {
            token = readRawHtmlToken(source, offset, false);
            if (token?.kind === 'opaque') {
                offset = token.to - 1;
                continue;
            }
            if (token && token.kind !== 'malformed') {
                offset = token.to - 1;
                continue;
            }
        }
        output.push(source[offset]);
        if (source[offset] === '<') {
            if (token?.nested) {
                openings.push({
                    from: output.length - 1,
                    quote: '',
                });
            }
            continue;
        }
        const opening = openings.at(-1);
        if (!opening) continue;
        if (opening.quote) {
            if (source[offset] === opening.quote) opening.quote = '';
            continue;
        }
        if (source[offset] === '"' || source[offset] === '\'') {
            opening.quote = source[offset];
            continue;
        }
        if (source[offset] !== '>') continue;
        const candidate = output.slice(opening.from).join('');
        openings.pop();
        if (isCompleteHtmlTag(candidate)) output.length = opening.from;
    }
    return output.join('').replace(
        /<\/?[A-Za-z][A-Za-z0-9:-]*/gu,
        ''
    );
}

function isCompleteHtmlTag(value) {
    const source = String(value || '');
    if (source[0] !== '<' || source.at(-1) !== '>') return false;
    let offset = source[1] === '/' ? 2 : 1;
    if (!/[A-Za-z]/u.test(source[offset] || '')) return false;
    while (/[A-Za-z0-9:-]/u.test(source[offset] || '')) offset++;
    let quote = '';
    for (; offset < source.length - 1; offset++) {
        const character = source[offset];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }
        if (character === '<') return false;
    }
    return !quote;
}

function isStandaloneReferenceParagraph(node) {
    return node.node.parent?.name === 'Document';
}

function findRawHtmlRemovalRanges(value) {
    const source = String(value || '');
    const ranges = [];
    const openTags = [];
    let offset = 0;
    while (offset < source.length) {
        const from = source.indexOf('<', offset);
        if (from < 0) break;
        const token = readRawHtmlToken(source, from);
        if (!token) {
            offset = from + 1;
            continue;
        }
        offset = Math.max(from + 1, token.to);
        if (token.kind === 'opaque'
            || token.kind === 'malformed'
            || token.kind === 'self-closing') {
            ranges.push({ from: token.from, to: token.to, remove: true });
            continue;
        }
        if (token.kind === 'closing') {
            let matched = false;
            for (let index = openTags.length - 1; index >= 0; index--) {
                if (openTags[index].name !== token.name) continue;
                const opening = openTags[index];
                openTags.length = index;
                ranges.push({ from: opening.from, to: token.to, remove: true });
                matched = true;
                break;
            }
            if (!matched) {
                ranges.push({ from: token.from, to: token.to, remove: true });
            }
            continue;
        }
        if (HTML_VOID_ELEMENTS.has(token.name)) {
            ranges.push({ from: token.from, to: token.to, remove: true });
            continue;
        }
        openTags.push(token);
    }
    for (const opening of openTags) {
        ranges.push({ from: opening.from, to: source.length, remove: true });
    }
    return ranges;
}

function readRawHtmlToken(source, from, recoverMalformed = true) {
    if (source.startsWith('<!--', from)) {
        return opaqueHtmlToken(source, from, '-->');
    }
    if (source.slice(from, from + 9).toUpperCase() === '<![CDATA[') {
        return opaqueHtmlToken(source, from, ']]>');
    }
    if (source.startsWith('<?', from)) {
        return opaqueHtmlToken(source, from, '?>');
    }
    if (source.startsWith('<!', from)) {
        return declarationHtmlToken(source, from);
    }

    let offset = from + 1;
    let closing = false;
    if (source[offset] === '/') {
        closing = true;
        offset++;
    }
    if (!/[A-Za-z]/u.test(source[offset] || '')) return null;
    const nameFrom = offset;
    while (/[A-Za-z0-9:-]/u.test(source[offset] || '')) offset++;
    const name = source.slice(nameFrom, offset).toLowerCase();
    let quote = '';
    for (; offset < source.length; offset++) {
        const character = source[offset];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }
        if (character === '<') {
            return {
                kind: 'malformed',
                from,
                to: recoverMalformed
                    ? findMalformedHtmlEnd(source, offset + 1)
                    : offset + 1,
                nested: true,
            };
        }
        if (character !== '>') continue;
        const to = offset + 1;
        if (closing) {
            return { kind: 'closing', name, from, to };
        }
        const selfClosing = /\/[\t ]*>$/u.test(source.slice(from, to));
        return {
            kind: selfClosing ? 'self-closing' : 'opening',
            name,
            from,
            to,
        };
    }
    return { kind: 'malformed', from, to: source.length };
}

function opaqueHtmlToken(source, from, terminator) {
    const terminatorFrom = source.indexOf(terminator, from + 2);
    return {
        kind: 'opaque',
        from,
        to: terminatorFrom < 0
            ? source.length
            : terminatorFrom + terminator.length,
    };
}

function declarationHtmlToken(source, from) {
    let quote = '';
    let subsetDepth = 0;
    for (let offset = from + 2; offset < source.length; offset++) {
        const character = source[offset];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }
        if (character === '[') {
            subsetDepth++;
            continue;
        }
        if (character === ']' && subsetDepth) {
            subsetDepth--;
            continue;
        }
        if (character === '>' && subsetDepth === 0) {
            return { kind: 'opaque', from, to: offset + 1 };
        }
    }
    return { kind: 'opaque', from, to: source.length };
}

function findMalformedHtmlEnd(source, from) {
    const closingTagPattern = /<\/[A-Za-z][A-Za-z0-9:-]*[\t ]*>/gu;
    closingTagPattern.lastIndex = from;
    const match = closingTagPattern.exec(source);
    return match ? match.index + match[0].length : source.length;
}

function stripResidualHtmlTags(value) {
    let previous;
    let output = String(value || '');
    do {
        previous = output;
        output = output
            .replace(/<br\s*\/?>/giu, ' ')
            .replace(/<\/?[A-Za-z][^>]*>/gu, ' ');
    } while (output !== previous);
    return output;
}

function cleanMarkdownForTranslation(value) {
    return stripResidualHtmlTags(
        String(value || '')
            .replace(/^ {0,3}#{1,6}[\t ]+/gmu, '')
            .replace(/[\t ]+#+[\t ]*$/gmu, '')
            .replace(/\r?\n {0,3}(?:=+|-+)[\t ]*$/gmu, '')
            .replace(/^ {0,3}(?:>\s*)+/gmu, '')
            .replace(/^ {0,3}(?:[-+*]|\d+[.)])[\t ]+/gmu, '')
            .replace(/!\[([^\]]*)\]\([^\r\n)]*\)/gu, '$1')
            .replace(/\[([^\]]+)\]\((⟦MKTERO_\d+⟧)\)/gu, '$1 ($2)')
    )
        .replace(/(^|[\s([{])[*_~]{1,3}(?=\S)/gu, '$1')
        .replace(/[*_~]{1,3}(?=$|[\s)\]},.!?:;])/gu, '')
        .replace(/\\([\\`*_[\]{}()#+.!<>~-])/gu, '$1')
        .replace(/[\t ]+/gu, ' ')
        .replace(/\s*\r?\n\s*/gu, ' ')
        .trim();
}

function hasEnglishTranslationCandidate(value) {
    const source = String(value || '');
    const latin = source.match(/[A-Za-z]/gu)?.length || 0;
    const cjk = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)
        ?.length || 0;
    return latin >= 3 && latin >= cjk;
}

function appendPatternRanges(output, source, pattern) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
        output.push({ from: match.index, to: match.index + match[0].length });
    }
    pattern.lastIndex = 0;
}

function mergeProtectedRanges(ranges) {
    const sorted = ranges
        .filter(range => Number.isSafeInteger(range.from)
            && Number.isSafeInteger(range.to)
            && range.from >= 0
            && range.to > range.from)
        .sort((left, right) => (
            left.from - right.from
            || Number(Boolean(right.remove)) - Number(Boolean(left.remove))
            || right.to - left.to
        ));
    const output = [];
    for (const range of sorted) {
        const previous = output.at(-1);
        if (!previous || range.from >= previous.to) {
            output.push({ ...range });
            continue;
        }
        if (range.remove && !previous.remove) {
            previous.remove = true;
        }
        previous.to = Math.max(previous.to, range.to);
    }
    return output;
}

function applyReplacements(source, replacements) {
    let output = '';
    let offset = 0;
    for (const replacement of replacements) {
        output += source.slice(offset, replacement.from);
        output += replacement.replacement;
        offset = replacement.to;
    }
    return output + source.slice(offset);
}

function overlapsAny(node, ranges) {
    return ranges.some(range => node.from < range.to && node.to > range.from);
}

function segmentSourceHash(source) {
    let hash = 0x811c9dc5;
    for (const character of String(source || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function splitAtSafeBoundaries(text, limit) {
    const parts = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(text.length, offset + limit);
        if (end < text.length) {
            end = safeBoundary(text, offset, end, limit);
        }
        const part = text.slice(offset, end).trim();
        if (part) parts.push(part);
        offset = end;
        while (/\s/u.test(text[offset] || '')) offset++;
    }
    return parts;
}

function safeBoundary(text, start, proposedEnd, limit) {
    let end = proposedEnd;
    const opening = text.lastIndexOf('⟦', end);
    const closing = text.lastIndexOf('⟧', end);
    if (opening > closing) {
        const tokenEnd = text.indexOf('⟧', end);
        end = opening > start ? opening : tokenEnd >= 0 ? tokenEnd + 1 : end;
    }
    const minimum = start + Math.floor(limit * 0.4);
    const candidate = text.slice(start, end);
    let boundary = -1;
    for (const match of candidate.matchAll(/[.!?。！？](?:["')\]]*)\s+/gu)) {
        const position = start + match.index + match[0].length;
        if (position >= minimum) boundary = position;
    }
    if (boundary < minimum) {
        const whitespace = candidate.lastIndexOf(' ');
        if (start + whitespace >= minimum) boundary = start + whitespace + 1;
    }
    return boundary >= minimum ? boundary : Math.max(start + 1, end);
}

function invalidPlaceholderError() {
    const error = new Error('The translation changed a protected placeholder');
    error.code = 'TRANSLATION_PLACEHOLDER_INVALID';
    return error;
}
