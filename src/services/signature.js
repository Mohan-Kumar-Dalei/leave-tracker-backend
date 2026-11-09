import sanitizeHtml from 'sanitize-html';

// People paste their own mail signature, copied from Gmail or Outlook. Only
// plain formatting, links and https images survive, so a pasted signature can
// never carry a script, a tracking form or a javascript: link into a mail or
// into the app.

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;
const SIZE = /^\d+(\.\d+)?(px|pt|em|rem|%)?$/i;
const SPACING = /^(-?\d+(\.\d+)?(px|pt|em|rem|%)?\s*){1,4}$/i;

const OPTIONS = {
  allowedTags: ['a', 'b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span', 'font', 'img', 'table', 'tbody', 'tr', 'td', 'hr', 'small'],
  allowedAttributes: {
    a: ['href', 'style'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    td: ['style', 'width', 'valign', 'align'],
    table: ['style', 'cellpadding', 'cellspacing', 'border', 'width'],
    font: ['color', 'size', 'face'],
    '*': ['style'],
  },
  allowedSchemes: ['https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https'], a: ['https', 'mailto', 'tel'] },
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [COLOR],
      'background-color': [COLOR],
      'font-size': [SIZE],
      'font-weight': [/^(bold|normal|[1-9]00)$/],
      'font-style': [/^(italic|normal)$/],
      'font-family': [/^[\w\s,'"-]+$/],
      'text-decoration': [/^(none|underline)$/],
      'text-align': [/^(left|right|center)$/],
      'vertical-align': [/^(top|middle|bottom)$/],
      'line-height': [SIZE],
      width: [SIZE],
      height: [SIZE],
      'max-width': [SIZE],
      margin: [SPACING],
      'margin-top': [SPACING],
      'margin-right': [SPACING],
      'margin-bottom': [SPACING],
      'margin-left': [SPACING],
      padding: [SPACING],
      'padding-top': [SPACING],
      'padding-right': [SPACING],
      'padding-bottom': [SPACING],
      'padding-left': [SPACING],
      'border-left': [/^[\w\s#().,-]+$/],
      'border-right': [/^[\w\s#().,-]+$/],
      'border-top': [/^[\w\s#().,-]+$/],
      'border-bottom': [/^[\w\s#().,-]+$/],
      border: [/^[\w\s#().,-]+$/],
      display: [/^(block|inline|inline-block)$/],
    },
  },
  // A picture without a usable address is dropped. Gmail's mail.google.com
  // links to attached pictures only open for the signed-in sender.
  exclusiveFilter: (frame) =>
    frame.tag === 'img' && (!frame.attribs.src || /^https:\/\/mail\.google\.com\//i.test(frame.attribs.src)),
  // Links open outside the app and do not pass on where they came from.
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
};

// The tags the transform adds must also be allowed.
OPTIONS.allowedAttributes.a.push('target', 'rel');

export const MAX_SIGNATURE_LENGTH = 20000;

export function cleanSignature(html = '') {
  return sanitizeHtml(String(html), OPTIONS).trim();
}

// A plain text copy for the text part of the mail.
export function signatureToText(html = '') {
  const withBreaks = cleanSignature(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table)>/gi, '\n')
    .replace(/<\/td>/gi, ' ');
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
