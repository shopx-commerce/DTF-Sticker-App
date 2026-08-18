import sgMail from "@sendgrid/mail";

// Thin wrapper so every caller shares one SendGrid setup/send path instead of re-implementing it.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  from?: string;
  attachments?: sgMail.MailDataRequired["attachments"];
}

// Overridable via MAIL_FROM; falls back to the verified sender already used by this project's SendGrid account.
const DEFAULT_FROM = process.env.MAIL_FROM || "sales@dtfmasters.com";

export function isMailerConfigured(): boolean {
  return !!process.env.SENDGRID_API_KEY;
}

let configured = false;
function ensureConfigured(): void {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }
  if (!configured) {
    sgMail.setApiKey(apiKey);
    configured = true;
  }
}

export async function sendMail(message: MailMessage): Promise<void> {
  ensureConfigured();
  const msg: sgMail.MailDataRequired = {
    to: message.to,
    from: message.from || DEFAULT_FROM,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(message.attachments ? { attachments: message.attachments } : {}),
  };
  await sgMail.send(msg);
}
