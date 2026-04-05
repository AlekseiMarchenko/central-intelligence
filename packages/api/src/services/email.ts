const RESEND_API_KEY = () => process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.EMAIL_FROM || "Central Intelligence <noreply@centralintelligence.online>";
const APP_URL = process.env.APP_URL || "https://centralintelligence.online";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail({ to, subject, html }: SendEmailParams): Promise<boolean> {
  const apiKey = RESEND_API_KEY();

  if (!apiKey) {
    // Dev fallback: log to console
    console.log(`[email] (no RESEND_API_KEY — dev mode)`);
    console.log(`[email] To: ${to}`);
    console.log(`[email] Subject: ${subject}`);
    console.log(`[email] Body: ${html.replace(/<[^>]+>/g, "").slice(0, 200)}...`);
    return true;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[email] Resend error: ${res.status} ${err}`);
    return false;
  }

  return true;
}

export async function sendMagicLink(email: string, token: string): Promise<boolean> {
  const link = `${APP_URL}/app?token=${encodeURIComponent(token)}`;

  return sendEmail({
    to: email,
    subject: "Sign in to Central Intelligence",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #fafafa; margin-bottom: 8px;">Central Intelligence</h2>
        <p style="color: #a1a1aa; margin-bottom: 24px;">Click below to sign in to your memory dashboard.</p>
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background: #6d5aff; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Sign in to Dashboard
        </a>
        <p style="color: #71717a; font-size: 13px; margin-top: 24px;">
          This link expires in 15 minutes. If you didn't request this, ignore this email.
        </p>
        <p style="color: #71717a; font-size: 12px; margin-top: 32px; border-top: 1px solid #27272a; padding-top: 16px;">
          Central Intelligence — Agents forget. CI remembers.
        </p>
      </div>
    `,
  });
}

export async function sendWelcomeLink(email: string, token: string, apiKey: string): Promise<boolean> {
  const link = `${APP_URL}/app?token=${encodeURIComponent(token)}`;

  return sendEmail({
    to: email,
    subject: "Welcome to Central Intelligence",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #fafafa; margin-bottom: 8px;">Welcome to Central Intelligence</h2>
        <p style="color: #a1a1aa; margin-bottom: 16px;">Your memory dashboard is ready. Click below to get started.</p>
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background: #6d5aff; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Open Dashboard
        </a>
        <div style="background: #111114; border: 1px solid #27272a; border-radius: 8px; padding: 16px; margin-top: 24px;">
          <p style="color: #a1a1aa; font-size: 13px; margin-bottom: 8px;">Your API key (save this — shown once):</p>
          <code style="color: #6d5aff; font-size: 14px; word-break: break-all;">${apiKey}</code>
        </div>
        <p style="color: #71717a; font-size: 13px; margin-top: 16px;">
          Use this key to connect Claude Code, Cursor, or Windsurf to your memory.
        </p>
        <p style="color: #71717a; font-size: 12px; margin-top: 32px; border-top: 1px solid #27272a; padding-top: 16px;">
          Central Intelligence — Agents forget. CI remembers.
        </p>
      </div>
    `,
  });
}
