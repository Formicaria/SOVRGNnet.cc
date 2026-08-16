/**
 * Sending email, without committing to a vendor.
 *
 * Email verification gates the safe account-linking path, and password reset
 * depends on it entirely — so this has to work, but which provider delivers it
 * is an operational choice that shouldn't be baked into the code.
 *
 * Two transports ship: a console one for development, and generic SMTP via an
 * injected sender. Anything else is a small adapter.
 */

export type Mail = {
  to: string;
  subject: string;
  text: string;
};

export interface MailTransport {
  send(mail: Mail): Promise<void>;
}

/**
 * Development transport: prints the message, including the link.
 *
 * Deliberately loud. A silent no-op would let someone build the whole signup
 * flow, never notice mail isn't configured, and ship it.
 */
export class ConsoleMailTransport implements MailTransport {
  async send(mail: Mail): Promise<void> {
    console.log(
      [
        "",
        "──────────── email (not actually sent) ────────────",
        `To:      ${mail.to}`,
        `Subject: ${mail.subject}`,
        "",
        mail.text,
        "───────────────────────────────────────────────────",
        "",
      ].join("\n")
    );
  }
}

/** Refuses rather than pretending, when production has no transport set up. */
export class UnconfiguredMailTransport implements MailTransport {
  async send(): Promise<void> {
    throw new Error(
      "No email transport is configured. Set MAIL_TRANSPORT and its settings, " +
        "or account verification and password reset cannot work."
    );
  }
}

/**
 * Running deliberately without email.
 *
 * A supported configuration, not a broken one — it avoids depending on a mail
 * vendor entirely. The costs are real and the rest of the service is written
 * to account for them:
 *
 *   - No address is ever verified, so an SSO identity can never *automatically*
 *     link to an existing local account on a server. Linking requires signing
 *     in locally first, on purpose: auto-linking on an unverified address is
 *     an account takeover.
 *   - Recovery codes become the only way back into an account. Losing them
 *     means losing the account, permanently, with nobody able to help.
 *
 * Silently dropping mail would leave both of those true while looking fine,
 * which is why this is a distinct mode you switch on rather than a default you
 * fall into.
 */
export class DisabledMailTransport implements MailTransport {
  async send(mail: Mail): Promise<void> {
    console.log(`[identity] email disabled; not sending "${mail.subject}" to ${mail.to}`);
  }
}

export function emailEnabled(): boolean {
  return (process.env.MAIL_TRANSPORT ?? "").toLowerCase() !== "none";
}

export function mailTransportFromEnv(): MailTransport {
  const configured = (process.env.MAIL_TRANSPORT ?? "").toLowerCase();

  if (configured === "none") return new DisabledMailTransport();
  if (configured === "console") return new ConsoleMailTransport();
  if (!configured && process.env.NODE_ENV !== "production") {
    return new ConsoleMailTransport();
  }
  return new UnconfiguredMailTransport();
}

// ------------------------------------------------------------------ messages

const FROM_NAME = "SOVRGNnet";

export function verificationEmail(to: string, link: string): Mail {
  return {
    to,
    subject: `Confirm your ${FROM_NAME} email address`,
    text: [
      "Confirm this address to finish setting up your account:",
      "",
      link,
      "",
      "This link works once and expires in 24 hours.",
      "",
      "Confirming matters for a specific reason: until an address is",
      "confirmed, servers won't link your account to an existing local one,",
      "because anyone could otherwise sign up with your address and take it",
      "over.",
      "",
      "If you didn't create an account, ignore this — nothing happens.",
    ].join("\n"),
  };
}

export function passwordResetEmail(to: string, link: string): Mail {
  return {
    to,
    subject: `Reset your ${FROM_NAME} password`,
    text: [
      "Use this link to set a new password:",
      "",
      link,
      "",
      "It works once and expires in one hour.",
      "",
      "If you didn't ask for this, ignore it. Your password hasn't changed,",
      "and nobody can use this link without access to this mailbox.",
    ].join("\n"),
  };
}

export function recoveryUsedEmail(to: string, remaining: number): Mail {
  return {
    to,
    subject: `A recovery code was used on your ${FROM_NAME} account`,
    text: [
      "Someone signed in using one of your recovery codes and set a new",
      "password.",
      "",
      `You have ${remaining} recovery ${remaining === 1 ? "code" : "codes"} left.`,
      "",
      "If this wasn't you, that person now controls the account. Reset your",
      "password immediately and regenerate your recovery codes.",
    ].join("\n"),
  };
}
