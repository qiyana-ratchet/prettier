import { diffArrays } from "diff";
import {
  convertEndOfLineOptionToCharacter,
  countEndOfLineCharacters,
  guessEndOfLine,
  normalizeEndOfLine,
} from "../common/end-of-line.js";
import { commentsPropertyInOptions } from "../constants.js";
import {
  addAlignmentToDoc,
  hardline,
  printDocToDebug,
  printDocToString as printDocToStringWithoutNormalizeOptions,
} from "../document/index.js";
import getAlignmentSize from "../utilities/get-alignment-size.js";
import { prepareToPrint, printAstToDoc } from "./ast-to-doc.js";
import getCursorLocation from "./get-cursor-node.js";
import massageAst from "./massage-ast.js";
import normalizeFormatOptions from "./normalize-format-options.js";
import parseText from "./parse.js";
import { resolveParser } from "./parser-and-printer.js";
import { calculateRange } from "./range.js";

const BOM = "\uFEFF";

const CURSOR = Symbol("cursor");

async function coreFormat(originalText, opts, addAlignmentSize = 0) {
  if (!originalText || originalText.trim().length === 0) {
    return { formatted: "", cursorOffset: -1, comments: [] };
  }

  const { ast, text } = await parseText(originalText, opts);

  if (opts.cursorOffset >= 0) {
    opts = {
      ...opts,
      ...getCursorLocation(ast, opts),
    };
  }

  let doc = await printAstToDoc(ast, opts, addAlignmentSize);

  if (addAlignmentSize > 0) {
    // Add a hardline to make the indents take effect, it will be removed later
    doc = addAlignmentToDoc([hardline, doc], addAlignmentSize, opts.tabWidth);
  }

  const result = printDocToStringWithoutNormalizeOptions(doc, opts);

  // Remove extra leading indentation as well as the added indentation after last newline
  if (addAlignmentSize > 0) {
    const trimmed = result.formatted.trim();

    if (result.cursorNodeStart !== undefined) {
      result.cursorNodeStart -= result.formatted.indexOf(trimmed);
      if (result.cursorNodeStart < 0) {
        result.cursorNodeStart = 0;
        result.cursorNodeText = result.cursorNodeText.trimStart();
      }
      if (
        result.cursorNodeStart + result.cursorNodeText.length >
        trimmed.length
      ) {
        result.cursorNodeText = result.cursorNodeText.trimEnd();
      }
    }

    result.formatted =
      trimmed + convertEndOfLineOptionToCharacter(opts.endOfLine);
  }

  const comments = opts[commentsPropertyInOptions];

  if (opts.cursorOffset >= 0) {
    // Roughly, our logic for preserving the user's cursor position is as
    // follows:
    // 1. Before formatting, identify from the AST the smallest possible region
    //    of the document that contains the cursor. (This will either be a leaf
    //    node, a range between two nodes, or a range between a node and the
    //    start or end of the document.)
    // 2. During formatting, record where this cursor-containing region gets
    //    written.
    // 3. Run a diff (with only insertions and deletions allowed) of the
    //    original vs formatted version of the region, with the cursor included
    //    as a character in the original version. By undoing the deletion of
    //    the cursor from the diff, we add the cursor to the appropriate point
    //    in the formatted version.
    //
    // Steps 1 and 2 have already happened; now we implement step 3.

    let oldCursorRegionStart;
    let oldCursorRegionText;

    let newCursorRegionStart;
    let newCursorRegionText;

    if (
      (opts.cursorNode || opts.nodeBeforeCursor || opts.nodeAfterCursor) &&
      result.cursorNodeText
    ) {
      newCursorRegionStart = result.cursorNodeStart;
      newCursorRegionText = result.cursorNodeText;

      if (opts.cursorNode) {
        oldCursorRegionStart = opts.locStart(opts.cursorNode);
        oldCursorRegionText = text.slice(
          oldCursorRegionStart,
          opts.locEnd(opts.cursorNode),
        );
      } else {
        if (!opts.nodeBeforeCursor && !opts.nodeAfterCursor) {
          throw new Error(
            "Cursor location must contain at least one of cursorNode, nodeBeforeCursor, nodeAfterCursor",
          );
        }
        oldCursorRegionStart = opts.nodeBeforeCursor
          ? opts.locEnd(opts.nodeBeforeCursor)
          : 0;
        const oldCursorRegionEnd = opts.nodeAfterCursor
          ? opts.locStart(opts.nodeAfterCursor)
          : text.length;

        oldCursorRegionText = text.slice(
          oldCursorRegionStart,
          oldCursorRegionEnd,
        );
      }
    } else {
      oldCursorRegionStart = 0;
      oldCursorRegionText = text;

      newCursorRegionStart = 0;
      newCursorRegionText = result.formatted;
    }

    const cursorOffsetRelativeToOldCursorRegionStart =
      opts.cursorOffset - oldCursorRegionStart;

    if (oldCursorRegionText === newCursorRegionText) {
      return {
        formatted: result.formatted,
        cursorOffset:
          newCursorRegionStart + cursorOffsetRelativeToOldCursorRegionStart,
        comments,
      };
    }

    // diff old and new cursor node texts, with a special cursor
    // symbol inserted to find out where it moves to

    // eslint-disable-next-line unicorn/prefer-spread
    const oldCursorNodeCharArray = oldCursorRegionText.split("");
    oldCursorNodeCharArray.splice(
      cursorOffsetRelativeToOldCursorRegionStart,
      0,
      CURSOR,
    );

    // eslint-disable-next-line unicorn/prefer-spread
    const newCursorNodeCharArray = newCursorRegionText.split("");
    const cursorNodeDiff = diffArrays(
      oldCursorNodeCharArray,
      newCursorNodeCharArray,
    );

    let cursorOffset = newCursorRegionStart;
    for (const entry of cursorNodeDiff) {
      if (entry.removed) {
        if (entry.value.includes(CURSOR)) {
          break;
        }
      } else {
        cursorOffset += entry.count;
      }
    }

    return { formatted: result.formatted, cursorOffset, comments };
  }

  return { formatted: result.formatted, cursorOffset: -1, comments };
}

function applyEndOfLine(formatted, cursorOffset, opts) {
  if (opts.endOfLine === "lf") {
    return { formatted, cursorOffset };
  }
  const eol = convertEndOfLineOptionToCharacter(opts.endOfLine);
  if (cursorOffset >= 0 && eol === "\r\n") {
    cursorOffset += countEndOfLineCharacters(
      formatted.slice(0, cursorOffset),
      "\n",
    );
  }
  return { formatted: formatted.replaceAll("\n", eol), cursorOffset };
}

async function formatRange(originalText, opts) {
  const { ast, text } = await parseText(originalText, opts);
  const calculatedRange = calculateRange(text, opts, ast);
  if (!calculatedRange) {
    return {
      formatted: originalText,
      cursorOffset: opts.cursorOffset,
      comments: [],
    };
  }
  const [rangeStart, rangeEnd] = calculatedRange;
  const rangeString = text.slice(rangeStart, rangeEnd);

  // Try to extend the range backwards to the beginning of the line.
  // This is so we can detect indentation correctly and restore it.
  // Use `Math.min` since `lastIndexOf` returns 0 when `rangeStart` is 0
  const rangeStart2 = Math.min(
    rangeStart,
    text.lastIndexOf("\n", rangeStart) + 1,
  );
  const indentString = text.slice(rangeStart2, rangeStart).match(/^\s*/)[0];

  const alignmentSize = getAlignmentSize(indentString, opts.tabWidth);

  const rangeResult = await coreFormat(
    rangeString,
    {
      ...opts,
      rangeStart: 0,
      rangeEnd: Number.POSITIVE_INFINITY,
      // Track the cursor offset only if it's within our range
      cursorOffset:
        opts.cursorOffset > rangeStart && opts.cursorOffset <= rangeEnd
          ? opts.cursorOffset - rangeStart
          : -1,
      // Always use `lf` to format, we'll replace it later
      endOfLine: "lf",
    },
    alignmentSize,
  );

  // Since the range contracts to avoid trailing whitespace,
  // we need to remove the newline that was inserted by the `format` call.
  const rangeTrimmed = rangeResult.formatted.trimEnd();

  // The user's originally requested range. `calculateRange` may have expanded
  // it to statement/declaration boundaries to obtain a parseable substring;
  // we use the original here to restrict which formatting changes are kept.
  const userRangeStart = opts.rangeStart;
  const userRangeEnd = Math.min(opts.rangeEnd, text.length);

  let { cursorOffset } = opts;

  // Fast path: when the calculated range fits entirely inside the user's
  // selection, every change is in-bounds and we can apply the formatted range
  // wholesale. This preserves existing behavior for the common case.
  if (rangeStart >= userRangeStart && rangeEnd <= userRangeEnd) {
    if (cursorOffset > rangeEnd) {
      // Cursor was past the end of the formatted region — shift by the
      // length delta introduced by formatting.
      cursorOffset += rangeTrimmed.length - rangeString.length;
    } else if (rangeResult.cursorOffset >= 0) {
      // Cursor was inside the formatted region — translate using the offset
      // computed by the inner format call.
      cursorOffset = rangeResult.cursorOffset + rangeStart;
    }
    // Otherwise (cursor before the range) leave it untouched.

    const formatted =
      text.slice(0, rangeStart) + rangeTrimmed + text.slice(rangeEnd);
    return {
      ...applyEndOfLine(formatted, cursorOffset, opts),
      comments: rangeResult.comments,
    };
  }

  // The calculated range exceeds the user's selection. Use a line-level diff
  // to identify which changes overlap the user's range, then keep only those.
  // Line-level (not character-level) diffing is intentional: it ensures that
  // related changes on the same line — e.g. matching quote pairs in
  // `'foo'` -> `"foo"` — are always applied together. A character-level diff
  // would split such pairs across hunks and could leave invalid output like
  // `"foo'` if the closing-quote hunk fell outside the user's selection.
  const origLines = rangeString.split("\n");
  const fmtLines = rangeTrimmed.split("\n");
  const lineDiffs = diffArrays(origLines, fmtLines);

  // Map the user range from absolute offsets to line indices within
  // `rangeString`. Both bounds are clamped to the extracted range so
  // out-of-range inputs produce well-defined line indices.
  const userStartInRange = Math.min(
    rangeString.length,
    Math.max(0, userRangeStart - rangeStart),
  );
  const userEndInRange = Math.min(
    rangeString.length,
    Math.max(userStartInRange, userRangeEnd - rangeStart),
  );
  const lineOf = (offset) => {
    let count = 0;
    for (let i = 0; i < offset; i++) {
      if (rangeString.charCodeAt(i) === 10 /* \n */) {
        count++;
      }
    }
    return count;
  };
  const userStartLine = lineOf(userStartInRange);
  const userEndLine = lineOf(userEndInRange);

  // `cursorInRange` is the cursor offset relative to `rangeString`, or -1 if
  // the cursor is outside the calculated range. We map it through the diff
  // by walking the entries and tracking three running positions:
  //   origCharPos   — chars consumed from `rangeString`
  //   appliedLength — length of the assembled output so far
  //   fmtCharPos    — chars consumed from `rangeTrimmed` (used to interpret
  //                   `rangeResult.cursorOffset`)
  const cursorInRange =
    opts.cursorOffset > rangeStart && opts.cursorOffset <= rangeEnd
      ? opts.cursorOffset - rangeStart
      : -1;

  let origCharPos = 0;
  let appliedLength = 0;
  let fmtCharPos = 0;
  let mappedCursor = -1; // -1 means we have not yet placed the cursor

  const resultLines = [];
  let idx = 0;

  while (idx < lineDiffs.length) {
    const entry = lineDiffs[idx];

    if (!entry.added && !entry.removed) {
      // Unchanged region — copy lines through verbatim.
      const text = entry.value.join("\n");
      // Account for the join("\n") between this region and the previous
      // group (handled implicitly by resultLines.join later).
      const segLen = text.length;
      if (
        cursorInRange >= 0 &&
        mappedCursor < 0 &&
        cursorInRange >= origCharPos &&
        cursorInRange <= origCharPos + segLen
      ) {
        mappedCursor =
          rangeStart + appliedLength + (cursorInRange - origCharPos);
      }
      resultLines.push(...entry.value);
      origCharPos += segLen + 1; // +1 for the joining "\n"
      appliedLength += segLen + 1;
      fmtCharPos += segLen + 1;
      idx++;
      continue;
    }

    // Group consecutive removed / added entries into a single change.
    const removedLines = [];
    const addedLines = [];
    while (
      idx < lineDiffs.length &&
      (lineDiffs[idx].removed || lineDiffs[idx].added)
    ) {
      if (lineDiffs[idx].removed) {
        removedLines.push(...lineDiffs[idx].value);
      } else {
        addedLines.push(...lineDiffs[idx].value);
      }
      idx++;
    }

    const removedText = removedLines.join("\n");
    const addedText = addedLines.join("\n");
    const removedSegLen =
      removedLines.length === 0 ? 0 : removedText.length + 1;
    const addedSegLen = addedLines.length === 0 ? 0 : addedText.length + 1;

    // The change's original line span is [changeStartLine, changeEndLine).
    const changeStartLine = lineOf(origCharPos);
    const changeEndLine = changeStartLine + removedLines.length;
    const overlapsUserRange =
      changeEndLine > userStartLine && changeStartLine <= userEndLine;

    if (overlapsUserRange) {
      // Apply the formatted version.
      if (
        cursorInRange >= 0 &&
        mappedCursor < 0 &&
        cursorInRange >= origCharPos &&
        cursorInRange <= origCharPos + removedSegLen
      ) {
        // The cursor was inside the original content of this hunk. Use the
        // formatter's cursor offset (within `rangeTrimmed`) to place it,
        // accounting for any earlier formatted hunks we have skipped.
        if (
          rangeResult.cursorOffset >= 0 &&
          rangeResult.cursorOffset >= fmtCharPos &&
          rangeResult.cursorOffset <= fmtCharPos + addedSegLen
        ) {
          mappedCursor =
            rangeStart +
            appliedLength +
            (rangeResult.cursorOffset - fmtCharPos);
        } else {
          // Fall back to the end of this applied hunk.
          mappedCursor = rangeStart + appliedLength + addedSegLen;
        }
      }
      resultLines.push(...addedLines);
      origCharPos += removedSegLen;
      appliedLength += addedSegLen;
      fmtCharPos += addedSegLen;
    } else {
      // Reject this change — keep the original text for this hunk.
      if (
        cursorInRange >= 0 &&
        mappedCursor < 0 &&
        cursorInRange >= origCharPos &&
        cursorInRange <= origCharPos + removedSegLen
      ) {
        mappedCursor =
          rangeStart + appliedLength + (cursorInRange - origCharPos);
      }
      resultLines.push(...removedLines);
      origCharPos += removedSegLen;
      appliedLength += removedSegLen;
      fmtCharPos += addedSegLen; // skip the formatted version
    }
  }

  const appliedString = resultLines.join("\n");
  const appliedDelta = appliedString.length - rangeString.length;

  if (cursorOffset > rangeEnd) {
    // Cursor was past the end of the calculated range — shift by the actual
    // length delta of what we ended up applying (NOT `rangeTrimmed.length -
    // rangeString.length`, which would over-count the rejected hunks).
    cursorOffset += appliedDelta;
  } else if (mappedCursor >= 0) {
    cursorOffset = mappedCursor;
  }
  // Otherwise (cursor before the range, or unmapped) leave it untouched.

  const formatted =
    text.slice(0, rangeStart) + appliedString + text.slice(rangeEnd);

  return {
    ...applyEndOfLine(formatted, cursorOffset, opts),
    comments: rangeResult.comments,
  };
}

function ensureIndexInText(text, index, defaultValue) {
  if (
    typeof index !== "number" ||
    Number.isNaN(index) ||
    index < 0 ||
    index > text.length
  ) {
    return defaultValue;
  }

  return index;
}

function normalizeIndexes(text, options) {
  let { cursorOffset, rangeStart, rangeEnd } = options;
  cursorOffset = ensureIndexInText(text, cursorOffset, -1);
  rangeStart = ensureIndexInText(text, rangeStart, 0);
  rangeEnd = ensureIndexInText(text, rangeEnd, text.length);

  return { ...options, cursorOffset, rangeStart, rangeEnd };
}

function normalizeInputAndOptions(text, options) {
  let { cursorOffset, rangeStart, rangeEnd, endOfLine } = normalizeIndexes(
    text,
    options,
  );

  const hasBOM = text.charAt(0) === BOM;

  if (hasBOM) {
    text = text.slice(1);
    cursorOffset--;
    rangeStart--;
    rangeEnd--;
  }

  if (endOfLine === "auto") {
    endOfLine = guessEndOfLine(text);
  }

  // get rid of CR/CRLF parsing
  if (text.includes("\r")) {
    const countCrlfBefore = (index) =>
      countEndOfLineCharacters(text.slice(0, Math.max(index, 0)), "\r\n");

    cursorOffset -= countCrlfBefore(cursorOffset);
    rangeStart -= countCrlfBefore(rangeStart);
    rangeEnd -= countCrlfBefore(rangeEnd);

    text = normalizeEndOfLine(text);
  }

  return {
    hasBOM,
    text,
    options: normalizeIndexes(text, {
      ...options,
      cursorOffset,
      rangeStart,
      rangeEnd,
      endOfLine,
    }),
  };
}

async function hasPragma(text, options) {
  const selectedParser = await resolveParser(options);
  return !selectedParser.hasPragma || selectedParser.hasPragma(text);
}

async function hasIgnorePragma(text, options) {
  const selectedParser = await resolveParser(options);
  return selectedParser.hasIgnorePragma?.(text);
}

async function formatWithCursor(originalText, originalOptions) {
  let { hasBOM, text, options } = normalizeInputAndOptions(
    originalText,
    await normalizeFormatOptions(originalOptions),
  );

  if (
    (options.rangeStart >= options.rangeEnd && text !== "") ||
    (options.requirePragma && !(await hasPragma(text, options))) ||
    (options.checkIgnorePragma && (await hasIgnorePragma(text, options)))
  ) {
    return {
      formatted: originalText,
      cursorOffset: originalOptions.cursorOffset,
      comments: [],
    };
  }

  let result;

  if (options.rangeStart > 0 || options.rangeEnd < text.length) {
    result = await formatRange(text, options);
  } else {
    if (
      !options.requirePragma &&
      options.insertPragma &&
      options.printer.insertPragma &&
      !(await hasPragma(text, options))
    ) {
      text = options.printer.insertPragma(text);
    }
    result = await coreFormat(text, options);
  }

  if (hasBOM) {
    result.formatted = BOM + result.formatted;

    if (result.cursorOffset >= 0) {
      result.cursorOffset++;
    }
  }

  return result;
}

async function parse(originalText, originalOptions, devOptions) {
  const { text, options } = normalizeInputAndOptions(
    originalText,
    await normalizeFormatOptions(originalOptions),
  );
  const parsed = await parseText(text, options);
  if (devOptions) {
    if (devOptions.preprocessForPrint) {
      parsed.ast = await prepareToPrint(parsed.ast, options);
    }
    if (devOptions.massage) {
      parsed.ast = massageAst(parsed.ast, options);
    }
  }
  return parsed;
}

async function formatAst(ast, options) {
  options = await normalizeFormatOptions(options);
  const doc = await printAstToDoc(ast, options);
  return printDocToStringWithoutNormalizeOptions(doc, options);
}

// Doesn't handle shebang for now
async function formatDoc(doc, options) {
  const text = printDocToDebug(doc);
  const { formatted } = await formatWithCursor(text, {
    ...options,
    parser: "__js_expression",
  });

  return formatted;
}

async function printToDoc(originalText, options) {
  options = await normalizeFormatOptions(options);
  const { ast } = await parseText(originalText, options);

  if (options.cursorOffset >= 0) {
    options = {
      ...options,
      ...getCursorLocation(ast, options),
    };
  }

  return printAstToDoc(ast, options);
}

async function printDocToString(doc, options) {
  return printDocToStringWithoutNormalizeOptions(
    doc,
    await normalizeFormatOptions(options),
  );
}

export {
  formatAst,
  formatDoc,
  formatWithCursor,
  parse,
  printDocToString,
  printToDoc,
};
