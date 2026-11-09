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

export function resetMail({ user, token }) {
  return build(`Reset your ${env.APP_NAME} password`, {
    heading: 'Reset your password',
    intro: `Hi ${user.name}, use the button below to choose a new password. This link works for 1 hour.`,
    action: { label: 'Reset password', url: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}` },
    footer: 'If you did not ask for this, you can ignore this email and your password stays the same.',
  });
}
