import env from '../config/env.js';
import { cleanSignature, signatureToText } from './signature.js';
import { departmentOf } from './scope.js';

// Leave mails read like the ones people already send by hand: the employee
// writes a "Leave Application" to the admin with the team in CC, and the admin
// replies in the same thread to the same people. The employee and the admin
// can edit the text before it goes. Each mail ends with the sender's signature.

export const APPLICATION_SUBJECT = 'Leave Application';
const subjectOf = (leave) => leave.subject || APPLICATION_SUBJECT;
const replySubject = (leave) => `Re: ${subjectOf(leave)}`;
export const REASON_PLACEHOLDER = '[reason]';

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function daysInWords(days) {
  if (days === 0.5) return 'half a day';
  const whole = Math.floor(days);
  const half = days - whole === 0.5;
  const word = WORDS[whole] ?? String(whole);
  if (half) return `${word} and a half days`;
  return `${word} ${whole === 1 ? 'day' : 'days'}`;
}

// 09/11/2026, the way people write it in these mails.
const slash = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

function nextDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function datesPhrase({ from, to, session }) {
  if (from === to) {
    const half = session === 'first' ? ', first half' : session === 'second' ? ', second half' : '';
    return `on (${slash(from)}${half})`;
  }
  if (nextDay(from) === to) return `on (${slash(from)} and ${slash(to)})`;
  return `from (${slash(from)} to ${slash(to)})`;
}

// "Personal work." becomes "due to personal work". A reason that already
// starts with "due to" or "because" is used as written.
function reasonPhrase(reason) {
  const text = reason.trim().replace(/[.\s]+$/, '');
  if (/^(due to|because)\b/i.test(text)) return text.charAt(0).toLowerCase() + text.slice(1);
  const lowered = /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  return `due to ${lowered}`;
}

const firstName = (name = '') => name.trim().split(/\s+/)[0];

export const designationOf = (person) =>
  person.designation || (person.role === 'admin' ? '' : env.DEFAULT_DESIGNATION);

/* Text the employee and the admin start from */

// The part of the letter that depends on the form. The apply form swaps it
// when the dates change, and keeps whatever else the employee typed.
export const requestSentence = (leave, typeName) =>
  `I would like to request ${daysInWords(leave.days)} of leave (${typeName}) ${datesPhrase(leave)}`;

export function applicationDraft({ employee, leave, typeName, reason }) {
  const because = reason ? reasonPhrase(reason) : `due to ${REASON_PLACEHOLDER}`;
  return [
    `Hi ${env.LEAVE_MAIL_GREETING},`,
    `${requestSentence(leave, typeName)} ${because}.`,
    'Kindly consider and approve my leave request.',
    `Thanks & Regards,\n${employee.name}`,
  ].join('\n\n');
}

export function replyDraft({ employee, reviewer, decision, note }) {
  const line = decision === 'approved' ? 'Your leave request is approved.' : 'Your leave request is not approved.';
  return [`Hi ${firstName(employee.name)},`, line, note, `Thanks,\n${firstName(reviewer.name)}`].filter(Boolean).join('\n\n');
}

// The middle of a letter, without the greeting and the sign-off. Used for the
// short reason shown in lists and notifications.
export function letterCore(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length > 1 && /^(hi|hello|dear)\b.*,$/i.test(paragraphs[0])) paragraphs.shift();
  if (paragraphs.length > 1 && /^(thanks|thank you|regards|best)/i.test(paragraphs.at(-1))) paragraphs.pop();
  return paragraphs.join(' ').replace(/\s+/g, ' ').trim();
}

// "... due to personal work." gives "personal work".
export function reasonFromLetter(text) {
  const match = text.match(/\bdue to\s+([^\n.]+)/i);
  const reason = match ? match[1].trim() : letterCore(text);
  return reason.slice(0, 500) || 'See the mail';
}

/* Signature */

// The company's standard signature, the same table everyone at Contify uses
// in Gmail: the logo with its tagline on the left, a thin line, then the
// person's name, designation and department, phone and email, the trial and
// demo links and LinkedIn. Only the person's own details change.
const UTM = 'utm_source=email_signature&utm_medium=email_signature&utm_campaign=email_signature_2023';
export const SIGNATURE = {
  siteUrl: `https://www.contify.com/?${UTM}`,
  logoUrl: 'https://112233.contify.com/images/contify-prelogin-assets/home/contify-png-assets/logo-with-tagline.png',
  trialUrl: `https://www.contify.com/signup/market-intelligence-free-trial/?${UTM}`,
  demoUrl: `https://www.contify.com/subscriber/market-intelligence/demo/?${UTM}`,
  linkedinUrl: 'https://www.linkedin.com/company/contify',
  linkedinIcon: 'https://112233.contify.com/images/email-sign/icn/linkedin-logo-blue.png?v=1',
};

export function signatureData() {
  return { companyName: env.COMPANY_NAME, ...SIGNATURE };
}

const FONT =
  'font-family:-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, Oxygen-Sans, Ubuntu, Cantarell, &quot;Helvetica Neue&quot;, Helvetica, Arial, sans-serif';

// "Assistant Manager - Content Integration".
function roleLine(person) {
  return [designationOf(person), departmentOf(person)].filter(Boolean).join(' - ');
}

// The standard signature for one person, as HTML.
export function standardSignatureHtml(person) {
  const phone = person.phone?.trim();
  const tel = phone ? phone.replace(/[^\d+]/g, '') : '';
  const contact = [
    phone
      ? `<a href="tel:${escapeHtml(tel)}" style="color:rgb(111, 111, 111);text-decoration:none" target="_blank" rel="noopener noreferrer">${escapeHtml(phone)}</a>`
      : '',
    `<a href="mailto:${escapeHtml(person.email)}" style="color:rgb(111, 111, 111);text-decoration:none" target="_blank" rel="noopener noreferrer">${escapeHtml(person.email)}</a>`,
  ]
    .filter(Boolean)
    .join(' • ');
  const role = roleLine(person);
  const blue = `color:rgb(0, 114, 195);text-decoration:none;${FONT}`;

  return `<table width="100%" cellspacing="0" cellpadding="0" style="font-style:normal;font-weight:400;background-color:rgb(255, 255, 255);color:rgb(32, 33, 36);${FONT};width:554px"><tbody><tr>`
    + `<td width="132" style="margin:0px;padding-right:16px"><a href="${escapeHtml(SIGNATURE.siteUrl)}" style="color:rgb(17, 85, 204);text-decoration:none" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(SIGNATURE.logoUrl)}" alt="logo contify" width="132" height="auto" /></a></td>`
    + `<td style="margin:7px 0px 0px;border-left:1px solid rgb(224, 224, 224);width:1px;height:90px;display:inline-block;padding-right:12px"><br /></td>`
    + `<td style="margin:0px">`
    + `<p style="margin:0px 0px 2px;color:rgb(22, 22, 22);font-size:16px;line-height:18px;font-weight:400;${FONT};padding:0px">${escapeHtml(person.name)}<br /></p>`
    + (role ? `<p style="margin:0px 0px 8px;color:rgb(22, 22, 22);font-size:12px;line-height:14px;font-weight:300;${FONT}">${escapeHtml(role)}</p>` : '')
    + `<p style="margin:0px 0px 8px;color:rgb(111, 111, 111);font-size:14px;line-height:16px;font-weight:400;${FONT}">${contact}</p>`
    + `<p style="margin:0px 0px 8px;color:rgb(168, 168, 168);font-size:14px;line-height:16px;${FONT};font-weight:400;text-decoration:none"><a href="${escapeHtml(SIGNATURE.trialUrl)}" style="${blue}" target="_blank" rel="noopener noreferrer">Free trial</a> • <a href="${escapeHtml(SIGNATURE.demoUrl)}" style="${blue}" target="_blank" rel="noopener noreferrer">Watch a demo</a></p>`
    + `<p style="margin:0px;color:rgb(111, 111, 111);font-size:14px;line-height:16px;font-weight:400;${FONT}"><a href="${escapeHtml(SIGNATURE.linkedinUrl)}" style="color:rgb(111, 111, 111);text-decoration:none" target="_blank" rel="noopener noreferrer">Follow us for the latest updates <img alt="Linked In icon" src="${escapeHtml(SIGNATURE.linkedinIcon)}" width="auto" height="15" style="height:15px;vertical-align:bottom" /></a></p>`
    + `</td></tr></tbody></table>`;
}

// A signature the person pasted wins over the standard one. It was cleaned on
// save and is cleaned again here, in case the rules got stricter since.
function signatureHtml(person) {
  if (person.signatureHtml) return cleanSignature(person.signatureHtml);
  return standardSignatureHtml(person);
}

function signatureText(person) {
  if (person.signatureHtml) return signatureToText(person.signatureHtml);
  return [
    person.name,
    roleLine(person),
    [person.phone, person.email].filter(Boolean).join(' • '),
    `Free trial: ${SIGNATURE.trialUrl}`,
    `Watch a demo: ${SIGNATURE.demoUrl}`,
    `Follow us for the latest updates: ${SIGNATURE.linkedinUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* Body */

const paragraphsOf = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

// One message: its paragraphs, then the sender's signature.
function messageHtml(text, person) {
  return `${paragraphsOf(text)
    .map((part) => `<p style="margin:0 0 14px">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('\n')}
<p style="margin:18px 0 8px;color:#5f6368">--</p>
${signatureHtml(person)}`;
}

const messageText = (text, person) => `${paragraphsOf(text).join('\n\n')}\n\n--\n${signatureText(person)}`;

// "Sat, 14 Nov 2026 at 6:31 PM", in the office's time zone.
function sentAt(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: env.TIMEZONE,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(new Date(date))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

// Typed text keeps its paragraphs and line breaks, and is escaped for HTML.
// With `quote`, the earlier mail follows underneath, the way Gmail shows it
// after Reply all: "On <date>, <name> <address> wrote:" and the mail, indented.
function compose(text, person, quote) {
  const quoted = quote
    ? `
<div style="margin-top:22px">
<div style="color:#5f6368;font-size:13px;margin:0 0 8px">On ${escapeHtml(sentAt(quote.at))}, ${escapeHtml(quote.from.name)} &lt;${escapeHtml(quote.from.email)}&gt; wrote:</div>
<blockquote style="margin:0 0 0 6px;border-left:1px solid #cccccc;padding-left:12px">
${messageHtml(quote.text, quote.from)}
</blockquote>
</div>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">
${messageHtml(text, person)}${quoted}
</div>
</body></html>`;

  const quotedText = quote
    ? `\n\nOn ${sentAt(quote.at)}, ${quote.from.name} <${quote.from.email}> wrote:\n\n${messageText(quote.text, quote.from)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`
    : '';

  return { html, text: `${messageText(text, person)}${quotedText}\n` };
}

/* Recipients */

const unique = (addresses, without = []) => {
  const skip = new Set(without.map((address) => address.toLowerCase()));
  const seen = new Set();
  return addresses.filter((address) => {
    const key = address?.toLowerCase();
    if (!key || skip.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Who the employee copied, or the usual list for leaves from before CC was chosen.
const ccOf = (leave) => leave.cc ?? env.leaveMailCc;

// Who the employee wrote to, or the admins for leaves from before To was chosen.
const toOf = (leave, admins) => leave.mailTo ?? admins.map((admin) => admin.email);

// Everyone on the first mail, for a reply to all.
const everyoneOn = (leave) => [...(leave.mailTo ?? []), ...ccOf(leave)];

/* Mails */

// The employee asks the people in To, with the people they chose in CC.
export function applicationMail({ employee, admins, leave, typeName }) {
  const to = unique(toOf(leave, admins), [employee.email]);
  const body = leave.message || applicationDraft({ employee, leave, typeName, reason: leave.reason });

  return {
    to,
    cc: unique(ccOf(leave), [...to, employee.email]),
    sender: employee,
    subject: subjectOf(leave),
    ...compose(body, employee),
  };
}

// The admin answers in the same thread, to the same people. With
// `quoteOriginal` the employee's own mail is quoted under the reply, like
// Gmail's Reply all, so everyone sees what was asked and the answer together.
export function decisionMail({ employee, reviewer, leave, decision, reply, note, quoteOriginal = false }) {
  const body = reply || replyDraft({ employee, reviewer, decision, note });
  const quote = quoteOriginal
    ? {
        at: leave.createdAt ?? new Date(),
        from: employee,
        text:
          leave.message || applicationDraft({ employee, leave, typeName: leave.leaveType?.name, reason: leave.reason }),
      }
    : null;
  return {
    to: [employee.email],
    cc: unique(everyoneOn(leave), [employee.email, reviewer.email]),
    sender: reviewer,
    subject: replySubject(leave),
    inReplyTo: leave.mailMessageId,
    ...compose(body, reviewer, quote),
  };
}

// A cancellation also lands in the same thread, written by whoever cancelled.
export function cancellationMail({ employee, admins, cancelledBy, leave }) {
  if (cancelledBy.id === employee.id) {
    const to = unique(toOf(leave, admins), [employee.email]);
    const body = [
      `Hi ${env.LEAVE_MAIL_GREETING},`,
      `I would like to cancel my leave request ${datesPhrase(leave)}. Please ignore my earlier request.`,
      `Thanks & Regards,\n${employee.name}`,
    ].join('\n\n');
    return {
      to,
      cc: unique(ccOf(leave), [...to, employee.email]),
      sender: employee,
      subject: replySubject(leave),
      inReplyTo: leave.mailMessageId,
      ...compose(body, employee),
    };
  }

  const body = [
    `Hi ${firstName(employee.name)},`,
    `Your leave ${datesPhrase(leave)} has been cancelled.`,
    `Thanks,\n${firstName(cancelledBy.name)}`,
  ].join('\n\n');
  return {
    to: [employee.email],
    cc: unique(everyoneOn(leave), [employee.email, cancelledBy.email]),
    sender: cancelledBy,
    subject: replySubject(leave),
    inReplyTo: leave.mailMessageId,
    ...compose(body, cancelledBy),
  };
}
