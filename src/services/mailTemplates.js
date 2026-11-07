import env from '../config/env.js';

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDay = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));

export const range = ({ from, to }) => (from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`);
const dayCount = (days) => `${days} ${days === 1 ? 'day' : 'days'}`;

function rowsHtml(rows) {
  return rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #DED8CA;color:#66685F;font-size:14px;width:120px;vertical-align:top">${escapeHtml(label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #DED8CA;color:#1C2321;font-size:15px">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join('');
}

function layout({ heading, intro, rows = [], action, footer }) {
  const button = action
    ? `<p style="margin:28px 0 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1F5C4D;color:#F8F5EE;text-decoration:none;padding:12px 22px;border-radius:4px;font-size:15px">${escapeHtml(action.label)}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#F4F1EA;font-family:Georgia,'Times New Roman',serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#FBF9F4;border:1px solid #DED8CA">
    <tr><td style="padding:32px">
      <p style="margin:0 0 20px;color:#66685F;font-family:Arial,sans-serif;font-size:13px">${escapeHtml(env.APP_NAME)}</p>
      <h1 style="margin:0 0 12px;color:#1C2321;font-size:26px;font-weight:400;line-height:1.2">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 20px;color:#1C2321;font-family:Arial,sans-serif;font-size:15px;line-height:1.55">${escapeHtml(intro)}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-family:Arial,sans-serif;border-top:1px solid #DED8CA">${rowsHtml(rows)}</table>
      ${button}
      ${footer ? `<p style="margin:24px 0 0;color:#66685F;font-family:Arial,sans-serif;font-size:13px;line-height:1.5">${escapeHtml(footer)}</p>` : ''}
    </td></tr>
  </table>
</body></html>`;
}

function toText({ heading, intro, rows = [], action }) {
  const lines = [heading, '', intro, '', ...rows.map(([label, value]) => `${label}: ${value}`)];
  if (action) lines.push('', `${action.label}: ${action.url}`);
  return lines.join('\n');
}

function build(subject, content) {
  return { subject, html: layout(content), text: toText(content) };
}

export function newRequestMail({ employee, leave, typeName }) {
  return build(`Leave request from ${employee.name}: ${range(leave)}`, {
    heading: `${employee.name} asked for leave`,
    intro: `${typeName} for ${dayCount(leave.days)}. This request is waiting for your decision.`,
    rows: [
      ['Employee', `${employee.name} (${employee.employeeId})`],
      ['Department', employee.department || 'Not set'],
      ['Leave type', typeName],
      ['Dates', range(leave)],
      ['Days', String(leave.days)],
      ['Reason', leave.reason],
    ],
    action: { label: 'Review request', url: `${env.APP_URL}/admin/requests?status=pending` },
  });
}

export function decisionMail({ leave, typeName, decision, reviewerName }) {
  const approved = decision === 'approved';
  const rows = [
    ['Leave type', typeName],
    ['Dates', range(leave)],
    ['Days', String(leave.days)],
    ['Decided by', reviewerName],
  ];
  if (leave.reviewNote) rows.push(['Note', leave.reviewNote]);

  return build(`Your leave was ${decision}: ${range(leave)}`, {
    heading: approved ? 'Your leave is approved' : 'Your leave was not approved',
    intro: approved
      ? `${typeName} for ${dayCount(leave.days)} is confirmed.`
      : `${typeName} for ${dayCount(leave.days)} was rejected. The days are back in your balance.`,
    rows,
    action: { label: 'Open my leave', url: `${env.APP_URL}/requests` },
  });
}

export function cancelledMail({ employee, leave, typeName, cancelledByAdmin }) {
  return build(`Leave cancelled: ${employee.name}, ${range(leave)}`, {
    heading: 'A leave was cancelled',
    intro: cancelledByAdmin
      ? `An admin cancelled this leave for ${employee.name}.`
      : `${employee.name} cancelled this leave.`,
    rows: [
      ['Leave type', typeName],
      ['Dates', range(leave)],
      ['Days', String(leave.days)],
    ],
    action: { label: 'Open requests', url: `${env.APP_URL}/admin/requests` },
  });
}

export function resetMail({ user, token }) {
  return build(`Reset your ${env.APP_NAME} password`, {
    heading: 'Reset your password',
    intro: `Hi ${user.name}, use the button below to choose a new password. This link works for 1 hour.`,
    action: { label: 'Reset password', url: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}` },
    footer: 'If you did not ask for this, you can ignore this email and your password stays the same.',
  });
}
