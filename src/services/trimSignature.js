// Pasted signatures carry a lot of empty space: blank lines, empty tags left
// behind by Gmail or Outlook, runs of spaces and line breaks in the source.
// This trims it before saving, so the signature stays small and looks the
// same. The app trims too, with a copy of this file
// (leave-tracker-frontend/src/lib/trimSignature.js); keep the two alike.

const SPACE = String.raw`(?:\s|&nbsp;|&#160;)`;
const BREAK = String.raw`(?:<br\s*\/?>)`;
const BLOCK = 'div|p|table|tbody|tr|td|br|hr';
const INLINE = 'span|font|b|strong|i|em|u|small|a';

// Line breaks and tabs in the source show as plain spaces anyway.
const SOURCE_BREAKS = /[\t\r\n]+/g;
// Space next to a block tag never shows.
const AROUND_BLOCKS = new RegExp(String.raw`\s*(<\/?(?:${BLOCK})\b[^>]*>)\s*`, 'gi');
// Inline tags with nothing in them.
const EMPTY_INLINE = new RegExp(String.raw`<(${INLINE})\b[^>]*>(${SPACE}*)<\/\1>`, 'gi');
// A paragraph or div with nothing in it is a blank line.
const EMPTY_BLOCK = new RegExp(String.raw`<(div|p)\b[^>]*>(?:${SPACE}|${BREAK})*<\/\1>`, 'gi');
const MANY_BREAKS = new RegExp(String.raw`(?:${BREAK}${SPACE}*){3,}`, 'gi');
// Next to a paragraph, div or table one break already makes a blank line.
const BREAKS_AFTER_BLOCK = new RegExp(String.raw`(</(?:div|p|table)>)(?:${BREAK}${SPACE}*){2,}`, 'gi');
const BREAKS_BEFORE_BLOCK = new RegExp(String.raw`(?:${BREAK}${SPACE}*){2,}(<(?:div|p|table)\b)`, 'gi');
const MANY_SPACES = new RegExp(`${SPACE}{3,}`, 'gi');
const BLANK_START = new RegExp(
  String.raw`^((?:<(?:div|p|span|font|table|tbody|tr|td)\b[^>]*>)*)(?:${SPACE}|${BREAK})+`,
  'i',
);
const BLANK_END = new RegExp(String.raw`(?:${SPACE}|${BREAK})+((?:<\/[a-z]+>)*)$`, 'i');
const EMPTY_STYLE = /\sstyle="\s*"/gi;

function pass(html) {
  return html
    .replace(SOURCE_BREAKS, ' ')
    .replace(AROUND_BLOCKS, '$1')
    .replace(EMPTY_INLINE, (_match, _tag, inner) => (inner ? ' ' : ''))
    .replace(EMPTY_BLOCK, '<br>')
    .replace(MANY_BREAKS, '<br><br>')
    .replace(BREAKS_AFTER_BLOCK, '$1<br>')
    .replace(BREAKS_BEFORE_BLOCK, '<br>$1')
    // Plain spaces in a row show as one; long runs of hard spaces become two.
    .replace(/ {2,}/g, ' ')
    .replace(MANY_SPACES, '&nbsp; ')
    .replace(BLANK_START, '$1')
    .replace(BLANK_END, '$1')
    .replace(EMPTY_STYLE, '')
    .trim();
}

export function trimSignature(html = '') {
  let out = String(html);
  // Removing one empty tag can leave its parent empty, so go round until
  // nothing changes.
  for (let round = 0; round < 8; round += 1) {
    const next = pass(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
