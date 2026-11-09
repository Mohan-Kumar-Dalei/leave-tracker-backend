import env from '../config/env.js';
import { cleanSignature, signatureToText } from './signature.js';

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

export function signatureData() {
  return {
    companyName: env.COMPANY_NAME,
    logoUrl: env.COMPANY_LOGO_URL,
    trialUrl: env.COMPANY_TRIAL_URL,
    demoUrl: env.COMPANY_DEMO_URL,
    linkedinUrl: env.COMPANY_LINKEDIN_URL,
  };
}

// A signature the person pasted wins over the standard one. It was cleaned on
// save and is cleaned again here, in case the rules got stricter since.
function signatureHtml(person) {
  if (person.signatureHtml) return cleanSignature(person.signatureHtml);
  const link = 'color:#1a73e8;text-decoration:none';
  const muted = 'color:#5f6368';
  const logo = env.COMPANY_LOGO_URL
    ? `<img src="${escapeHtml(env.COMPANY_LOGO_URL)}" alt="${escapeHtml(env.COMPANY_NAME)}" width="140" style="display:block;width:140px;height:auto;border:0">`
    : `<span style="font-size:24px;font-weight:bold;color:#1f2a44;letter-spacing:-0.5px">${escapeHtml(env.COMPANY_NAME)}</span>`;

  const contact = [
    person.phone ? `<span style="${muted}">${escapeHtml(person.phone)}</span>` : '',
    `<a href="mailto:${escapeHtml(person.email)}" style="${link}">${escapeHtml(person.email)}</a>`,
  ]
    .filter(Boolean)
    .join(`<span style="${muted}"> &bull; </span>`);

  const designation = designationOf(person);

  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:4px;font-family:Arial,Helvetica,sans-serif">
  <tr>
    <td style="padding:6px 18px 6px 0;vertical-align:middle">${logo}</td>
    <td style="padding:6px 0 6px 18px;border-left:1px solid #dadce0;vertical-align:top">
      <div style="font-size:15px;color:#202124">${escapeHtml(person.name)}</div>
      ${designation ? `<div style="font-size:12px;${muted};margin-top:2px">${escapeHtml(designation)}</div>` : ''}
      <div style="font-size:13px;margin-top:8px">${contact}</div>
      <div style="font-size:13px;margin-top:6px">
        <a href="${escapeHtml(env.COMPANY_TRIAL_URL)}" style="${link}">Free trial</a><span style="${muted}"> &bull; </span><a href="${escapeHtml(env.COMPANY_DEMO_URL)}" style="${link}">Watch a demo</a>
      </div>
      <div style="font-size:13px;${muted};margin-top:6px">
        Follow us for the latest updates
        <a href="${escapeHtml(env.COMPANY_LINKEDIN_URL)}" style="color:#0a66c2;font-weight:bold;text-decoration:none">LinkedIn</a>
      </div>
    </td>
  </tr>
</table>`;
}

function signatureText(person) {
  if (person.signatureHtml) return signatureToText(person.signatureHtml);
  return [
    env.COMPANY_NAME,
    person.name,
    designationOf(person),
    [person.phone, person.email].filter(Boolean).join(' • '),
    `Free trial: ${env.COMPANY_TRIAL_URL}`,
    `Watch a demo: ${env.COMPANY_DEMO_URL}`,
    `LinkedIn: ${env.COMPANY_LINKEDIN_URL}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/* Body */

// Typed text keeps its paragraphs and line breaks, and is escaped for HTML.
function compose(text, person) {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">
${paragraphs.map((part) => `<p style="margin:0 0 14px">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('\n')}
<p style="margin:18px 0 8px;color:#5f6368">--</p>
${signatureHtml(person)}
</div>
</body></html>`;

  return { html, text: `${paragraphs.join('\n\n')}\n\n--\n${signatureText(person)}\n` };
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

// The admin answers in the same thread, to the same people.
export function decisionMail({ employee, reviewer, leave, decision, reply, note }) {
  const body = reply || replyDraft({ employee, reviewer, decision, note });
  return {
    to: [employee.email],
    cc: unique(everyoneOn(leave), [employee.email, reviewer.email]),
    sender: reviewer,
    subject: replySubject(leave),
    inReplyTo: leave.mailMessageId,
    ...compose(body, reviewer),
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
