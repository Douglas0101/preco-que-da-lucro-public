import { Resend } from "resend";

export interface AuthEmailMessage {
  to: string;
  url: string;
}

export interface TransactionalEmailAdapter {
  sendEmailVerification(message: AuthEmailMessage): Promise<void>;
  sendPasswordReset(message: AuthEmailMessage): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!,
  );
}

export class ResendEmailAdapter implements TransactionalEmailAdapter {
  private readonly resend: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.resend = new Resend(apiKey);
  }

  private async send(input: AuthEmailMessage & { subject: string; intro: string }): Promise<void> {
    const safeUrl = escapeHtml(input.url);
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: `${input.intro}\n\n${input.url}\n\nSe você não solicitou esta ação, ignore este e-mail.`,
      html: `<p>${escapeHtml(input.intro)}</p><p><a href="${safeUrl}">Continuar com segurança</a></p><p>Se você não solicitou esta ação, ignore este e-mail.</p>`,
    });
    if (error) {
      throw new Error("Falha ao entregar e-mail transacional");
    }
  }

  async sendEmailVerification(message: AuthEmailMessage): Promise<void> {
    await this.send({
      ...message,
      subject: "Confirme seu e-mail — Preço que Dá Lucro",
      intro: "Confirme seu e-mail para ativar sua conta.",
    });
  }

  async sendPasswordReset(message: AuthEmailMessage): Promise<void> {
    await this.send({
      ...message,
      subject: "Recupere sua senha — Preço que Dá Lucro",
      intro: "Use o link abaixo para definir uma nova senha.",
    });
  }
}

let emailAdapter: TransactionalEmailAdapter | undefined;

export function getEmailAdapter(): TransactionalEmailAdapter {
  if (emailAdapter) return emailAdapter;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error(
      "RESEND_API_KEY e AUTH_EMAIL_FROM são obrigatórias para e-mails de autenticação",
    );
  }
  emailAdapter = new ResendEmailAdapter(apiKey, from);
  return emailAdapter;
}

export function setEmailAdapterForTests(adapter: TransactionalEmailAdapter | undefined): void {
  emailAdapter = adapter;
}
