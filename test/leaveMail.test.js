import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.SMTP_USER = 'leave@example.com';
process.env.LEAVE_MAIL_CC = 'lead@example.com, team@example.com, HR@example.com';
process.env.COMPANY_LOGO_URL = '';

const { applicationMail, cancellationMail, decisionMail, reasonFromLetter, letterCore } = await import('../src/services/leaveMail.js');

const admin = { id: 'a1', role: 'admin', name: 'Asha Rao', email: 'asha@example.com', designation: 'Assistant Manager', phone: '+91 90000 00000' };
const employee = { id: 'e1', role: 'employee', name: 'Ravi Kumar Das', email: 'ravi@example.com', designation: '', phone: '' };
const leave = { from: '2026-11-09', to: '2026-11-10', session: 'full', days: 2, reason: 'Personal work.', mailMessageId: '<leave.1@example.com>' };

describe('leave mails', () => {
  it('writes the application the way people do by hand', () => {
    const mail = applicationMail({ employee, admins: [admin], leave, typeName: 'Casual/Sick' });
    assert.equal(mail.subject, 'Leave Application');
    assert.deepEqual(mail.to, ['asha@example.com']);
    assert.deepEqual(mail.cc, ['lead@example.com', 'team@example.com', 'hr@example.com']);
    assert.equal(mail.sender, employee);
    assert.match(mail.text, /^Hi Sir,/);
    assert.match(mail.text, /request two days of leave \(Casual\/Sick\) on \(09\/11\/2026 and 10\/11\/2026\) due to personal work\./);
    assert.match(mail.text, /Thanks & Regards,\nRavi Kumar Das/);
    assert.match(mail.text, /\nAnalyst\n/, 'falls back to the default designation');
  });

  it('describes half days and longer ranges', () => {
    const half = applicationMail({ employee, admins: [admin], leave: { ...leave, to: leave.from, session: 'first', days: 0.5 }, typeName: 'Casual/Sick' });
    assert.match(half.text, /half a day of leave \(Casual\/Sick\) on \(09\/11\/2026, first half\)/);
    const long = applicationMail({ employee, admins: [admin], leave: { ...leave, to: '2026-11-13', days: 5, reason: 'due to a wedding' }, typeName: 'Earned' });
    assert.match(long.text, /five days of leave \(Earned\) from \(09\/11\/2026 to 13\/11\/2026\) due to a wedding\./);
  });

  it('replies in the same thread with the admin signature', () => {
    const mail = decisionMail({ employee, reviewer: admin, leave, decision: 'approved', note: '' });
    assert.equal(mail.subject, 'Re: Leave Application');
    assert.equal(mail.inReplyTo, '<leave.1@example.com>');
    assert.deepEqual(mail.to, ['ravi@example.com']);
    assert.equal(mail.sender, admin);
    assert.match(mail.text, /^Hi Ravi,\n\nYour leave request is approved\.\n\nThanks,\nAsha\n/);
    assert.match(mail.text, /Assistant Manager\n\+91 90000 00000 • asha@example\.com/);

    const rejected = decisionMail({ employee, reviewer: admin, leave, decision: 'rejected', note: 'Release week.' });
    assert.match(rejected.text, /not approved\.\n\nRelease week\./);
  });

  it('threads cancellations from whoever cancelled', () => {
    const own = cancellationMail({ employee, admins: [admin], cancelledBy: employee, leave });
    assert.equal(own.sender, employee);
    assert.deepEqual(own.to, ['asha@example.com']);
    const byAdmin = cancellationMail({ employee, admins: [admin], cancelledBy: admin, leave });
    assert.equal(byAdmin.sender, admin);
    assert.match(byAdmin.text, /Your leave on \(09\/11\/2026 and 10\/11\/2026\) has been cancelled\./);
  });

  it('sends the text and CC the employee chose, and the admin answers the same people', () => {
    const message = 'Hi Sir,\n\nI need leave on Monday due to a family function.\nBack on Tuesday.\n\nThanks & Regards,\nRavi Kumar Das';
    const chosen = { ...leave, message, cc: ['lead@example.com', 'ravi@example.com', 'asha@example.com'] };
    const mail = applicationMail({ employee, admins: [admin], leave: chosen, typeName: 'Casual' });
    assert.deepEqual(mail.cc, ['lead@example.com']);
    assert.match(mail.html, /family function\.<br>Back on Tuesday\./);

    const reply = decisionMail({
      employee,
      reviewer: admin,
      leave: chosen,
      decision: 'approved',
      reply: 'Hi Ravi,\n\nApproved, enjoy.\n\nThanks,\nAsha',
    });
    assert.deepEqual(reply.cc, ['lead@example.com']);
    assert.match(reply.text, /^Hi Ravi,\n\nApproved, enjoy\./);

    const titled = { ...chosen, subject: 'Leave on Monday' };
    assert.equal(applicationMail({ employee, admins: [admin], leave: titled, typeName: 'Casual' }).subject, 'Leave on Monday');
    assert.equal(decisionMail({ employee, reviewer: admin, leave: titled, decision: 'approved' }).subject, 'Re: Leave on Monday');
  });

  it('writes to the chosen To, replies to all of them, and uses a pasted signature', () => {
    const chosen = { ...leave, mailTo: ['asha@example.com', 'boss@example.com'], cc: ['lead@example.com'] };
    const pasted = { ...employee, signatureHtml: '<b>Ravi K.</b><br>Team Content<br><a href="https://example.com">Site</a>' };
    const mail = applicationMail({ employee: pasted, admins: [admin], leave: chosen, typeName: 'Casual' });
    assert.deepEqual(mail.to, ['asha@example.com', 'boss@example.com']);
    assert.deepEqual(mail.cc, ['lead@example.com']);
    assert.match(mail.html, /<b>Ravi K\.<\/b><br \/>Team Content/);
    assert.match(mail.text, /--\nRavi K\.\nTeam Content\nSite\n$/);
    assert.equal(mail.html.includes('Free trial'), false, 'the standard signature is not added');

    const reply = decisionMail({ employee, reviewer: admin, leave: chosen, decision: 'approved' });
    assert.deepEqual(reply.cc, ['boss@example.com', 'lead@example.com']);
  });

  it('pulls a short reason out of a letter', () => {
    assert.equal(reasonFromLetter('Hi Sir,\n\nI would like leave on (09/11/2026) due to personal work.\n\nThanks,\nRavi'), 'personal work');
    assert.equal(letterCore('Hi Sir,\n\nMy sister is getting married.\n\nThanks & Regards,\nRavi'), 'My sister is getting married.');
  });

  it('escapes typed text in the HTML', () => {
    const mail = applicationMail({ employee: { ...employee, name: '<script>x</script>' }, admins: [admin], leave: { ...leave, reason: '<img src=x onerror=alert(1)>' }, typeName: 'Casual' });
    assert.equal(mail.html.includes('<script>'), false);
    assert.equal(mail.html.includes('<img src=x'), false);
  });
});
