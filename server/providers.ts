import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  isConfigured: () => boolean;
  sendEmail: (message: EmailMessage) => Promise<void>;
}

function readEnv(key: string): string {
  return (process.env[key] || '').trim();
}

export function resolveSmtpConfig() {
  const host = readEnv('SMTP_HOST');
  const from = readEnv('SMTP_FROM');
  const parsedPort = Number.parseInt(readEnv('SMTP_PORT') || '587', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;

  const rawSecure = readEnv('SMTP_SECURE').toLowerCase();
  let secure: boolean;
  if (rawSecure === 'true' || rawSecure === '1' || rawSecure === 'yes') {
    secure = true;
  } else if (rawSecure === 'false' || rawSecure === '0' || rawSecure === 'no') {
    secure = false;
  } else {
    secure = port === 465;
  }

  const user = readEnv('SMTP_USER');
  const pass = readEnv('SMTP_PASS');

  return {
    isConfigured: Boolean(host && from),
    host,
    port,
    secure,
    user,
    pass,
    from,
  };
}

export function createDefaultEmailSender(): EmailSender {
  const isConfigured = () => resolveSmtpConfig().isConfigured;

  const sendEmail = async (message: EmailMessage) => {
    const cfg = resolveSmtpConfig();
    if (!cfg.isConfigured) {
      const err = new Error('SMTP email provider is not configured.');
      Object.assign(err, { code: 'SMTP_NOT_CONFIGURED' });
      throw err;
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 15000,
      auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    });

    await transporter.sendMail({
      from: cfg.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  };

  return { isConfigured, sendEmail };
}

export function buildBoutiqueEmailHtml(params: {
  heading: string;
  intro: string;
  actionLabel: string;
  actionUrl: string;
  footnote: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background-color:#FFF9F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#242124;">
    <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid rgba(73,36,62,0.12);border-radius:20px;padding:32px;">
      <p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#B76E79;">Sahithi Collections</p>
      <h1 style="margin:0 0 16px 0;font-family:Georgia,serif;font-size:28px;font-weight:600;color:#49243E;">${params.heading}</h1>
      <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#242124;">${params.intro}</p>
      <a href="${params.actionUrl}" style="display:inline-block;background-color:#49243E;color:#FFF9F5;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:12px;">${params.actionLabel}</a>
      <p style="margin:24px 0 0 0;font-size:12px;line-height:1.6;color:#6E656B;">${params.footnote}</p>
    </div>
  </body>
</html>`;
}
