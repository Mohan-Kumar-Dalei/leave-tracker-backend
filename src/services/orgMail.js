import env from '../config/env.js';
import { build } from './mailTemplates.js';

// Mails of the organisation: the owner's invitation to a department's
// assistant manager, the department's join link for the team, and the note
// that a join request was approved.

const ROLE_NAME = { manager: 'Manager', assistant: 'Assistant Manager' };

export const inviteUrl = (token) => `${env.APP_URL}/join/invite/${encodeURIComponent(token)}`;
export const joinUrl = (code) => `${env.APP_URL}/join/${encodeURIComponent(code)}`;

export function inviteMail({ invite, department, token, inviter }) {
  const role = ROLE_NAME[invite.role];
  return build(`You are invited to ${env.COMPANY_NAME} as ${role} of ${department.name}`, {
    heading: `Join ${department.name} as ${role}`,
    intro: `Hi ${invite.name}, ${inviter.name} has set up ${department.name} at ${env.COMPANY_NAME} and invited you as its ${role}. Open the link to create your account. It works for 14 days.`,
    rows: [
      ['Department', department.name],
      ['Your role', role],
      ['Sign in with', invite.email],
    ],
    action: { label: 'Accept the invitation', url: inviteUrl(token) },
    footer: 'Once you are in, send your team the department link from My department and approve them as they join.',
  });
}

export function joinLinkMail({ department, code, sender }) {
  return build(`Join ${department.name} at ${env.COMPANY_NAME}`, {
    heading: `Join ${department.name}`,
    intro: `Hi, ${sender.name} has invited you to join ${department.name} at ${env.COMPANY_NAME}. Open the link, fill in your details and choose a password. You can sign in once your request is approved.`,
    rows: [['Department', department.name]],
    action: { label: 'Join the department', url: joinUrl(code) },
    footer: 'If you were not expecting this, you can ignore this email.',
  });
}

export function approvedMail({ request, department, approver }) {
  return build(`You have joined ${department.name}`, {
    heading: `Welcome to ${department.name}`,
    intro: `Hi ${request.name}, ${approver.name} approved your request. You can sign in now with your email and the password you chose.`,
    rows: [
      ['Department', department.name],
      ['Sign in with', request.email],
    ],
    action: { label: 'Sign in', url: `${env.APP_URL}/login` },
  });
}
